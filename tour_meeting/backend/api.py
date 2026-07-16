import json
import os
import uuid
import asyncio
import time
import logging
from collections import deque
from dataclasses import dataclass, field
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Literal, Dict, Set, Deque, Tuple, Any
from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator
from ..messages import AIMessage, HumanMessage
import openai

from ..tour_meeting import AITourMeeting, sanitize_name
from ..participant import Participant
from ..generate_with_ai import draft_route_for_human
from ..llm import load_llm, verify_api_key, get_env_key_name, list_ollama_models, pull_ollama_model, ModelNotFoundError, clear_llm_cache, get_commercial_model_info
from ..types import MeetingStarted, TurnStart, Delta, TurnFinal, HumanTurn, HumanVote, HumanSelectSpeaker, HumanAsk, PhaseMessage, RoutePlanUpdate, Timeout, MeetingFinished, RetryNotification, AskPending, AskExchange, ProposalVoteResult, SatisfiedUpdate, RoundEnd, DeadlockIntervention, MeetingEvent

logger = logging.getLogger(__name__)

#---------------- 
# FastAPI models
#---------------- 
class ParticipantIn(BaseModel):
    # Stable identifier, unique within the meeting. Assigned by the server on
    # first save; the display name carries no identity so duplicates are fine.
    id: Optional[str] = None
    # Name given to the live persona. Equals `name` unless another participant
    # already uses it, in which case a " (2)"-style suffix keeps the meeting
    # engine (which addresses speakers by name) unambiguous. None for drafts.
    engine_name: Optional[str] = None
    # Display icon (cosmetic; not used by the persona). Either a generated
    # character spec {kind:"generated", shape, palette, face} or an uploaded
    # image {kind:"image", src:<data URL>}. Stored loosely so unknown/legacy
    # shapes round-trip without dropping the participant.
    avatar: Optional[Dict[str, Any]] = None
    # llm setting
    model_name: str
    temperature: float
    # Reasoning effort for models that support it (gpt-5 family):
    # "none"/"low"/"medium"/"high". None or "none" omits the parameter.
    reasoning_effort: Optional[str] = None
    seed: int
    max_tokens: Optional[int] = None
    max_context_length: Optional[int] = None
    context_mode: Literal["auto_compact", "truncate", "fixed_turns"] = "auto_compact"
    auto_compact_threshold: float = Field(default=0.8, gt=0.0, le=1.0)
    auto_compact_target: float = Field(default=0.5, gt=0.0, le=1.0)
    compact_recent_ratio: float = Field(default=0.7, gt=0.0, lt=1.0)
    fixed_turns_count: int = Field(default=10, ge=1)
    # persona setting
    name: str
    background: str
    personality: str
    preferences: str
    personal_goals: str
    role: str
    speaking_style: str
    explanation_style: str
    web_search: bool = True
    max_steps: int = 5
    # Optional full override of the participant system prompt.  Empty/None falls
    # back to the default SYS_PARTICIPANT template.
    system_prompt: Optional[str] = None
    # A still-incomplete draft: stored in the meeting's config (so it is
    # meeting-scoped and survives reloads) but not added as a live persona, and
    # excluded when the meeting runs.
    incomplete: bool = False

    @model_validator(mode="after")
    def validate_context_config(self):
        if self.auto_compact_target >= self.auto_compact_threshold:
            raise ValueError("auto_compact_target must be smaller than auto_compact_threshold")
        return self


def _new_participant_id() -> str:
    return uuid.uuid4().hex[:12]


def _effective_reasoning_effort(model_name: str, effort: Optional[str]) -> Optional[str]:
    """Reasoning effort to pass to load_llm.

    Only the gpt-5 family supports the parameter; "none"/empty means
    "omit it" (provider default) rather than a literal value.
    """
    if not (model_name or "").startswith("openai/gpt-5"):
        return None
    if effort in (None, "", "none"):
        return None
    return effort


def _unique_engine_name(meeting: "AITourMeeting", base: str) -> str:
    """Pick a persona name not used by any current participant.

    The meeting engine addresses speakers by name, so live personas must have
    unique names even when users give two participants the same display name.
    """
    base = (base or "").strip() or "Participant"
    existing = {p.name for p in meeting.participants}
    if base not in existing:
        return base
    n = 2
    while f"{base} ({n})" in existing:
        n += 1
    return f"{base} ({n})"


def _spawn_persona(meeting: "AITourMeeting", payload: "ParticipantIn") -> None:
    """Create and register a live persona for a complete payload.

    Sets ``payload.engine_name`` to the unique name the persona speaks under
    (None for drafts). Raises HTTPException(400) when the model is unavailable.
    No-op for incomplete drafts, which never become personas.
    """
    payload.engine_name = None
    if payload.incomplete:
        return
    try:
        llm = load_llm(
            model_name=payload.model_name,
            temperature=payload.temperature,
            seed=payload.seed,
            max_tokens=payload.max_tokens,
            max_context_length=payload.max_context_length,
            reasoning_effort=_effective_reasoning_effort(
                payload.model_name, payload.reasoning_effort
            ),
        )
    except ModelNotFoundError:
        model_display = payload.model_name
        if payload.model_name.startswith("ollama/"):
            model_display = payload.model_name.split("ollama/", 1)[1]
        raise HTTPException(
            400,
            detail=f"Model '{model_display}' is not installed. Please go to Settings and pull the model first.",
        )
    payload.engine_name = _unique_engine_name(meeting, payload.name)
    meeting.add_participant(
        Participant(
            llm=llm,
            name=payload.engine_name,
            background=payload.background,
            personality=payload.personality,
            preferences=payload.preferences,
            personal_goals=payload.personal_goals,
            role=payload.role,
            speaking_style=payload.speaking_style,
            explanation_style=payload.explanation_style,
            web_search=payload.web_search,
            max_steps=payload.max_steps,
            context_mode=payload.context_mode,
            auto_compact_threshold=payload.auto_compact_threshold,
            auto_compact_target=payload.auto_compact_target,
            compact_recent_ratio=payload.compact_recent_ratio,
            fixed_turns_count=payload.fixed_turns_count,
            system_prompt=payload.system_prompt,
        )
    )


def _engine_order(info: dict) -> List[str]:
    """Translate the stored id-based order into engine persona names."""
    meeting: "AITourMeeting" = info["meeting"]
    by_id = {cfg.get("id"): cfg for cfg in info.get("participants_config", [])}
    out: List[str] = []
    for x in info.get("order", []):
        if x == "__YOU__":
            out.append(x)
            continue
        cfg = by_id.get(x)
        if cfg and not cfg.get("incomplete") and cfg.get("engine_name"):
            out.append(cfg["engine_name"])
    for p in meeting.participants:
        if p.name not in out:
            out.append(p.name)
    return out


class MeetingCreate(BaseModel):
    title: Optional[str] = None

class MeetingUpdate(BaseModel):
    title: Optional[str] = None
    include_human: Optional[bool] = None
    human_name: Optional[str] = None
    human_avatar: Optional[dict] = None
    human_role: Optional[str] = None
    max_turns: Optional[int] = None
    time_limit: Optional[int] = None
    travel_date: Optional[str] = None
    time_window_start: Optional[str] = None
    time_window_end: Optional[str] = None
    budget: Optional[str] = None
    initialization_turn_rule: Optional[str] = None
    initialization_voting_rule: Optional[str] = None
    volunteer_mode: Optional[bool] = None
    balanced_turns: Optional[bool] = None
    vote_turn_rule: Optional[str] = None
    vote_settings_linked: Optional[bool] = None
    single_decider: Optional[str] = None

class MeetingOut(BaseModel):
    id: str
    title: str
    created_at: str
    participant_count: int
    include_human: bool = False
    human_name: str = "You"
    human_avatar: Optional[dict] = None
    human_role: str = "attendee"
    has_history: bool = False
    status: str = "idle"
    status_detail: Optional[str] = None
    travel_date: Optional[str] = None
    time_window_start: Optional[str] = None
    time_window_end: Optional[str] = None
    budget: Optional[str] = None
    initialization_turn_rule: str = "round_robin"
    initialization_voting_rule: str = "majority"
    volunteer_mode: bool = False
    balanced_turns: bool = True
    vote_turn_rule: Optional[str] = None
    vote_settings_linked: bool = True
    single_decider: Optional[str] = None
    elapsed_seconds: int = 0

class MessageOut(BaseModel):
    name: str
    content: str
    turn: int


class ParticipantsPayload(BaseModel):
    participants: List[ParticipantIn]


class ApiKeyUpdate(BaseModel):
    provider: Literal["openai", "anthropic", "google"]
    api_key: str


class ApiKeyStatus(BaseModel):
    provider: str
    configured: bool
    masked_key: Optional[str] = None


class OrderUpdate(BaseModel):
    order: List[str]  # participant ids + "__YOU__" 例: ["a1b2c3", "__YOU__", "d4e5f6"]


class GoalUpdate(BaseModel):
    goal: str


class RandomSampleResponse(BaseModel):
    title: str
    participants: List[ParticipantIn]
    global_goal: str
    include_human: bool = False
    travel_date: Optional[str] = None
    budget: Optional[str] = None
    time_window_start: Optional[str] = None
    time_window_end: Optional[str] = None
    max_turns: int = 100
    time_limit: Optional[int] = None
    initialization_turn_rule: str = "round_robin"
    initialization_voting_rule: str = "majority"
    volunteer_mode: bool = False
    balanced_turns: bool = True
    vote_turn_rule: str = "round_robin"
    vote_settings_linked: bool = True


class RandomSampleRequest(BaseModel):
    title: Optional[str] = None
    global_goal: Optional[str] = None
    include_human: Optional[bool] = None
    max_turns: Optional[int] = None
    time_limit: Optional[int] = None
    travel_date: Optional[str] = None
    budget: Optional[str] = None
    time_window_start: Optional[str] = None
    time_window_end: Optional[str] = None
    initialization_turn_rule: Optional[str] = None
    initialization_voting_rule: Optional[str] = None
    volunteer_mode: Optional[bool] = None
    balanced_turns: Optional[bool] = None
    vote_turn_rule: Optional[str] = None
    vote_settings_linked: Optional[bool] = None


@dataclass
class MeetingRuntime:
    meeting_id: str
    goal: str
    max_turns: int
    time_limit: Optional[int]
    status: str = "idle"
    reason: Optional[str] = None
    task: Optional[asyncio.Task] = None
    queues: Set[asyncio.Queue] = field(default_factory=set)
    buffer: Deque[dict] = field(default_factory=lambda: deque(maxlen=200))
    stop_requested: bool = False
    resume_from_history: bool = False
    started_at: Optional[float] = None
    accumulated: float = 0.0
    mode: Literal["route_initialization", "discussion"] = "discussion"

    def snapshot_buffer(self) -> List[dict]:
        return list(self.buffer)

#------------- 
# In-memory storage
#------------- 
def mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 2:
        return "***"
    if len(key) <= 8:
        return f"{key[0]}***{key[-1]}"
    prefix = key[:4]
    suffix = key[-4:]
    return f"{prefix}***{suffix}"


API_PROVIDERS = ["openai", "anthropic", "google"]
DEFAULT_GLOBAL_GOAL = "Plan a one-day sightseeing tour in Kyoto."
TURN_RULE_OPTIONS = ["round_robin", "inviting", "facilitating", "random"]
VOTE_TURN_RULE_OPTIONS = [*TURN_RULE_OPTIONS, "parallel"]
VOTING_RULE_OPTIONS = [
    "majority",
    "unanimous",
    "most_pleasure",
    "least_misery",
    "single_decider",
]
HUMAN_ROLE_OPTIONS = ["attendee", "facilitator"]

# How long a stop request waits for the run loop to wind down gracefully
# before the run task is cancelled outright.
STOP_GRACE_SECONDS = 15.0


class MeetingStore:
    def __init__(self, storage_path: Optional[Path] = None):
        # meeting_id -> {meeting: AITourMeeting, title: str, created_at: str,
        #                include_human: bool, order: List[str], participants_config: List[dict]}
        self.storage_path = storage_path or (
            Path(__file__).resolve().parent.parent / "data" / "meetings.json"
        )
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        self.meetings: Dict[str, dict] = {}
        self.active_runs: Dict[str, MeetingRuntime] = {}
        self._load()

    # ---------- Persistence helpers ----------
    @staticmethod
    def _resolve_persisted_elapsed(payload: dict) -> int:
        value = payload.get("elapsed_seconds")
        if isinstance(value, (int, float)):
            return int(value)
        # Legacy files predate elapsed_seconds; fall back to the analytics
        # meeting duration when one was recorded.
        meta = (payload.get("analytics_data") or {}).get("metadata") or {}
        duration = meta.get("duration")
        if isinstance(duration, (int, float)) and duration > 0:
            return int(duration)
        return 0

    def _serialize_history(self, meeting: AITourMeeting) -> List[dict]:
        serialized: List[dict] = []
        for msg in getattr(meeting, "history", []):
            route_plan = None
            turn_value = None
            steps_log = None
            steps_label = None
            max_steps = None
            score = None
            public_text = None

            if isinstance(msg, AIMessage):
                extras = getattr(msg, "additional_kwargs", {}) or {}
                route_plan = extras.get("route_plan")
                turn_value = extras.get("turn")
                steps_log = extras.get("steps_log")
                steps_label = extras.get("steps_label")
                max_steps = extras.get("max_steps")
                score = extras.get("score")
                public_text = extras.get("public_text")
            if isinstance(msg, HumanMessage):
                extras = getattr(msg, "additional_kwargs", {}) or {}
                turn_value = extras.get("turn")
                score = extras.get("score")
                public_text = extras.get("public_text")
                steps_log = extras.get("steps_log")
                steps_label = extras.get("steps_label")
                max_steps = extras.get("max_steps")
                candidate = {
                    "type": "human",
                    "name": getattr(msg, "name", ""),
                    "content": msg.content,
                }
                if score is not None:
                    candidate["score"] = score
                # A human vote/turn carries its asks as steps and its verdict as
                # a steps_label, exactly like an LLM voter — serialize them so a
                # reloaded meeting threads them under the proposal the same way.
                if steps_log:
                    candidate["steps_log"] = steps_log
                if steps_label:
                    candidate["steps_label"] = steps_label
                if max_steps is not None:
                    candidate["max_steps"] = max_steps
            elif isinstance(msg, AIMessage):
                candidate = {
                    "type": "ai",
                    "name": getattr(msg, "name", ""),
                    "content": msg.content,
                }
                if route_plan:
                    candidate["route_plan"] = route_plan
                if steps_log:
                    candidate["steps_log"] = steps_log
                if steps_label:
                    candidate["steps_label"] = steps_label
                if max_steps is not None:
                    candidate["max_steps"] = max_steps
                if score is not None:
                    candidate["score"] = score
            else:
                continue
            if isinstance(public_text, str):
                candidate["public_text"] = public_text

            if turn_value is not None:
                candidate["turn"] = turn_value
            if serialized and serialized[-1] == candidate:
                continue
            serialized.append(candidate)
        return serialized

    def _load(self) -> None:
        if not self.storage_path.exists():
            return
        try:
            data = json.loads(self.storage_path.read_text())
        except Exception:
            # Fallback to empty store on parse failure
            return

        for meeting_id, payload in data.get("meetings", {}).items():
            meeting = AITourMeeting()
            participants_config = payload.get("participants", [])
            reconstructed_participants = []
            for cfg in participants_config:
                if not cfg.get("id"):
                    cfg["id"] = _new_participant_id()
                reconstructed_participants.append(cfg)
                if cfg.get("incomplete"):
                    # Drafts live in the config only; they never become personas.
                    cfg["engine_name"] = None
                    continue
                try:
                    llm = load_llm(
                        model_name=cfg.get("model_name", "openai/gpt-5.4-mini"),
                        temperature=cfg.get("temperature", 0.7),
                        seed=cfg.get("seed", 42),
                        max_tokens=cfg.get("max_tokens"),
                        max_context_length=cfg.get("max_context_length"),
                        reasoning_effort=_effective_reasoning_effort(
                            cfg.get("model_name", ""), cfg.get("reasoning_effort")
                        ),
                    )
                    engine_name = cfg.get("engine_name") or _unique_engine_name(
                        meeting, cfg.get("name", "")
                    )
                    cfg["engine_name"] = engine_name
                    participant = Participant(
                        llm=llm,
                        name=engine_name,
                        background=cfg.get("background", ""),
                        personality=cfg.get("personality", ""),
                        preferences=cfg.get("preferences", ""),
                        personal_goals=cfg.get("personal_goals", ""),
                        role="attendee" if cfg.get("role") in (None, "atendee") else cfg.get("role"),
                        speaking_style=cfg.get("speaking_style", "friendly"),
                        explanation_style=cfg.get("explanation_style", "auto"),
                        web_search=cfg.get("web_search", cfg.get("web_search_init", True)),
                        max_steps=cfg.get("max_steps", 5),
                        context_mode=cfg.get("context_mode", "auto_compact"),
                        auto_compact_threshold=cfg.get("auto_compact_threshold", 0.8),
                        auto_compact_target=cfg.get("auto_compact_target", 0.5),
                        compact_recent_ratio=cfg.get("compact_recent_ratio", 0.7),
                        fixed_turns_count=cfg.get("fixed_turns_count", 10),
                        system_prompt=cfg.get("system_prompt"),
                    )
                    meeting.add_participant(participant)
                except Exception:
                    # Skip participants that fail to load
                    continue

            include_human = payload.get("include_human", False)
            if include_human:
                meeting.enable_human(name="You")

            # Order is stored as participant ids (+ "__YOU__"). Older files
            # stored display names instead — migrate those to ids here.
            known_ids = {cfg["id"] for cfg in reconstructed_participants}
            order: List[str] = []
            claimed: Set[str] = set()
            for x in payload.get("order", []):
                if x == "__YOU__":
                    if x not in order:
                        order.append(x)
                    continue
                if x in known_ids:
                    if x not in order:
                        order.append(x)
                        claimed.add(x)
                    continue
                legacy = next(
                    (
                        cfg
                        for cfg in reconstructed_participants
                        if cfg.get("name") == x and cfg["id"] not in claimed
                    ),
                    None,
                )
                if legacy is not None:
                    order.append(legacy["id"])
                    claimed.add(legacy["id"])
            for cfg in reconstructed_participants:
                if cfg["id"] not in order:
                    order.append(cfg["id"])

            history_payload = payload.get("history", [])
            reconstructed_history = []
            for msg in history_payload:
                if msg.get("type") == "human":
                    turn_value = msg.get("turn")
                    score = msg.get("score")
                    public_text = msg.get("public_text")
                    kwargs = {}
                    additional_kwargs = {}
                    if turn_value is not None:
                        additional_kwargs["turn"] = turn_value
                    if score is not None:
                        additional_kwargs["score"] = score
                    if isinstance(public_text, str):
                        additional_kwargs["public_text"] = public_text
                    if additional_kwargs:
                        kwargs["additional_kwargs"] = additional_kwargs
                    candidate = HumanMessage(
                        content=msg.get("content", ""),
                        name=msg.get("name", ""),
                        **kwargs,
                    )
                elif msg.get("type") == "ai":
                    route_plan = msg.get("route_plan")
                    steps_log = msg.get("steps_log")
                    steps_label = msg.get("steps_label")
                    max_steps = msg.get("max_steps")
                    score = msg.get("score")
                    turn_value = msg.get("turn")
                    public_text = msg.get("public_text")

                    kwargs = {}
                    additional_kwargs = {}
                    if route_plan is not None:
                        additional_kwargs["route_plan"] = route_plan
                    if steps_log is not None:
                        additional_kwargs["steps_log"] = steps_log
                    if steps_label is not None:
                        additional_kwargs["steps_label"] = steps_label
                    if max_steps is not None:
                        additional_kwargs["max_steps"] = max_steps
                    if score is not None:
                        additional_kwargs["score"] = score
                    if turn_value is not None:
                        additional_kwargs["turn"] = turn_value
                    if isinstance(public_text, str):
                        additional_kwargs["public_text"] = public_text
                    if additional_kwargs:
                        kwargs["additional_kwargs"] = additional_kwargs

                    candidate = AIMessage(
                        content=msg.get("content", ""),
                        name=msg.get("name", ""),
                        **kwargs,
                    )
                else:
                    continue

                if reconstructed_history:
                    last = reconstructed_history[-1]
                    if (
                        isinstance(last, candidate.__class__)
                        and last.name == candidate.name
                        and last.content == candidate.content
                    ):
                        continue
                reconstructed_history.append(candidate)
            if reconstructed_history:
                meeting.history = reconstructed_history

            goal = payload.get("global_goal")
            if not isinstance(goal, str) or not goal.strip():
                if (
                    reconstructed_history
                    and isinstance(reconstructed_history[0], HumanMessage)
                    and getattr(reconstructed_history[0], "name", "") == "MeetingGoal"
                ):
                    goal = reconstructed_history[0].content
                else:
                    goal = DEFAULT_GLOBAL_GOAL

            if meeting.history:
                first_msg = meeting.history[0]
                if (
                    isinstance(first_msg, HumanMessage)
                    and getattr(first_msg, "name", "") == "MeetingGoal"
                ):
                    first_msg.content = goal

            raw_max_turns = payload.get("max_turns")
            if isinstance(raw_max_turns, int) and raw_max_turns > 0:
                max_turns = raw_max_turns
            else:
                max_turns = 100

            raw_time_limit = payload.get("time_limit")
            if isinstance(raw_time_limit, int) and raw_time_limit > 0:
                time_limit: Optional[int] = raw_time_limit
            else:
                time_limit = None

            init_turn_rule = payload.get("initialization_turn_rule")
            if init_turn_rule not in TURN_RULE_OPTIONS:
                init_turn_rule = "round_robin"
            init_voting_rule = payload.get("initialization_voting_rule")
            if init_voting_rule not in VOTING_RULE_OPTIONS:
                init_voting_rule = "majority"

            status = payload.get("status", "idle")
            if status not in {"idle", "running", "finished", "timeout", "stopped", "error", "stopping"}:
                status = "idle"
            status_detail = payload.get("status_detail")
            # A fresh process has no run tasks: an in-flight status persisted
            # by a previous process can never progress, so settle it.
            if status in {"running", "stopping"}:
                status = "stopped"
                status_detail = status_detail or "Interrupted by server restart"

            self.meetings[meeting_id] = {
                "meeting": meeting,
                "title": payload.get("title", f"Meeting {meeting_id[:8]}"),
                "created_at": payload.get("created_at", datetime.utcnow().isoformat()),
                "include_human": include_human,
                "human_name": payload.get("human_name") or "You",
                "human_avatar": payload.get("human_avatar"),
                "human_role": (
                    payload.get("human_role")
                    if payload.get("human_role") in HUMAN_ROLE_OPTIONS
                    else "attendee"
                ),
                "order": order,
                "participants_config": reconstructed_participants,
                "global_goal": goal,
                "max_turns": max_turns,
                "time_limit": time_limit,
                "travel_date": payload.get("travel_date"),
                "time_window_start": payload.get("time_window_start"),
                "time_window_end": payload.get("time_window_end"),
                "budget": payload.get("budget"),
                "initialization_turn_rule": init_turn_rule,
                "initialization_voting_rule": init_voting_rule,
                "volunteer_mode": payload.get("volunteer_mode", False),
                "balanced_turns": payload.get("balanced_turns", True),
                "vote_settings_linked": bool(payload.get("vote_settings_linked", True)),
                "vote_turn_rule": (
                    payload.get("vote_turn_rule")
                    if payload.get("vote_turn_rule") in VOTE_TURN_RULE_OPTIONS
                    else None
                ),
                "single_decider": payload.get("single_decider"),
                "status": status,
                "status_detail": status_detail,
                "elapsed_seconds": self._resolve_persisted_elapsed(payload),
            }
            if self.meetings[meeting_id]["vote_settings_linked"]:
                self.meetings[meeting_id]["vote_turn_rule"] = None
            meeting.set_order(_engine_order(self.meetings[meeting_id]))

            # Restore persisted analytics data
            # Always reconstruct turns/proposals/votes/routes from history
            # (stored analytics_data may be stale or incomplete).
            # Only use stored analytics_data for non-reconstructible fields
            # like llm_calls, token_usage, and processing_time.
            saved_analytics = payload.get("analytics_data")
            if isinstance(saved_analytics, dict):
                # Restore only non-reconstructible runtime data
                act = saved_analytics.get("discussion_dynamics", {}).get("activity", {})
                meeting.analytics.discussion_dynamics.activity.llm_calls = list(act.get("llm_calls", []))
                meeting.analytics.discussion_dynamics.activity.token_usage_per_agent = dict(act.get("token_usage_per_agent", {}))
                meeting.analytics.discussion_dynamics.activity.processing_time_per_agent = dict(act.get("processing_time_per_agent", {}))
                # Restore metadata
                meta = saved_analytics.get("metadata", {})
                if meta.get("start_time"):
                    meeting.analytics.start_time = meta["start_time"]
                if meta.get("end_time"):
                    meeting.analytics.end_time = meta["end_time"]
            else:
                # Backwards compat: restore llm_calls from old format
                saved_llm_calls = payload.get("llm_calls")
                if isinstance(saved_llm_calls, list) and saved_llm_calls:
                    meeting.analytics.discussion_dynamics.activity.llm_calls = saved_llm_calls
            # Reconstruct turns, proposals, votes, routes from history
            self._reconstruct_analytics_from_history(meeting, history_payload)

    @staticmethod
    def _reconstruct_analytics_from_history(meeting: "AITourMeeting", history_payload: list) -> None:
        """Rebuild basic analytics from serialized history for old meetings without analytics_data."""
        import re
        analytics = meeting.analytics
        last_proposer: str = ""
        in_voting_phase: bool = False  # track route_first voting phase

        for msg in history_payload:
            typ = msg.get("type")
            name = msg.get("name", "")
            turn = msg.get("turn")
            route_plan = msg.get("route_plan")
            steps_label = msg.get("steps_label", "")
            content = msg.get("content", "")

            if typ == "ai" and name and name != "System" and turn is not None:
                # Count turns per agent (sanitized name → display name)
                display_name = name.replace("_", " ")
                word_count = len(content.split())
                analytics.discussion_dynamics.activity.record_turn(
                    display_name, word_count, 0.0,
                )

                # Proposal: AI message with route_plan
                if route_plan:
                    analytics.proposal_made(display_name, route_plan, turn)
                    analytics.route_updated(turn, route_plan, "proposal")
                    last_proposer = display_name

                # Vote: free_conversation uses steps_label "accept"/"reject"
                if steps_label in ("accept", "reject"):
                    analytics.vote_recorded(
                        display_name,
                        last_proposer,
                        turn=turn,
                        approved=(steps_label == "accept"),
                    )
                # Vote: route_first voting phase — AI messages without steps_label
                elif in_voting_phase:
                    analytics.vote_recorded(display_name, last_proposer, turn=turn)

            elif typ == "ai" and name == "System":
                # Detect voting phase transitions (route_first workflow)
                if "Route Voting" in content or "Consensus Voting" in content:
                    in_voting_phase = True
                elif "Proposal Voting" in content:
                    # free_conversation voting — extract proposer name
                    # Also enter voting phase for older meetings without steps_label
                    in_voting_phase = True
                    m = re.search(r"([^\n]+?)(?:'s| 's) proposal is being voted on", content)
                    if m:
                        last_proposer = m.group(1).replace("_", " ")

                # End of voting phase: route selected or proposal accepted
                if "Initial Route Selected" in content or "Route Selected" in content:
                    in_voting_phase = False
                    # Extract proposer from "Initial route proposed by <name>"
                    m = re.search(r"proposed by\s+(.+?)[\.\n]", content)
                    if m:
                        last_proposer = m.group(1).strip().replace("_", " ")
                    if last_proposer:
                        analytics.proposal_accepted(last_proposer)

                if "Proposal Accepted" in content or "route was accepted" in content:
                    in_voting_phase = False
                    # Extract proposer from "X's route was accepted"
                    if not last_proposer:
                        m = re.search(r"([^\n]+?)(?:'s| 's) route was accepted", content)
                        if m:
                            last_proposer = m.group(1).replace("_", " ")
                    if last_proposer:
                        analytics.proposal_accepted(last_proposer)

                # Phase changes that end voting
                if "Route Refinement" in content or "Free Conversation" in content:
                    in_voting_phase = False

                # Track accepted routes from system messages with route_plan
                if route_plan:
                    if turn is not None:
                        analytics.route_updated(turn, route_plan, "accepted")

    def save(self) -> None:
        data = {"meetings": {}}
        for meeting_id, entry in self.meetings.items():
            meeting: AITourMeeting = entry["meeting"]
            runtime = self.active_runs.get(meeting_id)
            if runtime is not None:
                entry["elapsed_seconds"] = self._runtime_elapsed_seconds(runtime)
            data["meetings"][meeting_id] = {
                "title": entry["title"],
                "created_at": entry["created_at"],
                "include_human": entry.get("include_human", False),
                "human_name": entry.get("human_name") or "You",
                "human_avatar": entry.get("human_avatar"),
                "human_role": entry.get("human_role") or "attendee",
                "order": entry.get("order", []),
                "participants": entry.get("participants_config", []),
                "history": self._serialize_history(meeting),
                "global_goal": entry.get("global_goal", DEFAULT_GLOBAL_GOAL),
                "max_turns": entry.get("max_turns", 100),
                "time_limit": entry.get("time_limit"),
                "travel_date": entry.get("travel_date"),
                "time_window_start": entry.get("time_window_start"),
                "time_window_end": entry.get("time_window_end"),
                "budget": entry.get("budget"),
                "initialization_turn_rule": entry.get("initialization_turn_rule", "round_robin"),
                "initialization_voting_rule": entry.get("initialization_voting_rule", "majority"),
                "volunteer_mode": entry.get("volunteer_mode", False),
                "balanced_turns": entry.get("balanced_turns", True),
                "vote_settings_linked": entry.get("vote_settings_linked", True),
                "vote_turn_rule": entry.get("vote_turn_rule"),
                "single_decider": entry.get("single_decider"),
                "status": entry.get("status", "idle"),
                "status_detail": entry.get("status_detail"),
                "elapsed_seconds": int(entry.get("elapsed_seconds", 0) or 0),
                "analytics_data": meeting.analytics.export_to_dict(),
            }
        try:
            self.storage_path.write_text(json.dumps(data, indent=2))
        except Exception:
            # Ignore persistence errors to avoid breaking API calls
            pass

    # ---------- CRUD ----------
    def create_meeting(self, title: Optional[str] = None) -> str:
        meeting_id = str(uuid.uuid4())
        created_at = datetime.utcnow().isoformat()
        self.meetings[meeting_id] = {
            "meeting": AITourMeeting(),
            "title": title or f"Meeting {len(self.meetings) + 1}",
            "created_at": created_at,
            "include_human": False,
            "human_name": "You",
            "human_avatar": None,
            "human_role": "attendee",
            "order": [],
            "participants_config": [],
            "global_goal": DEFAULT_GLOBAL_GOAL,
            "max_turns": 100,
            "time_limit": None,
            "travel_date": None,
            "time_window_start": None,
            "time_window_end": None,
            "budget": None,
            "initialization_turn_rule": "round_robin",
            "initialization_voting_rule": "majority",
            "volunteer_mode": False,
            "balanced_turns": True,
            "vote_settings_linked": True,
            "vote_turn_rule": None,
            "single_decider": None,
            "status": "idle",
            "status_detail": None,
            "elapsed_seconds": 0,
        }
        self.save()
        return meeting_id

    def get_meeting(self, meeting_id: str) -> Optional[AITourMeeting]:
        entry = self.meetings.get(meeting_id)
        return entry["meeting"] if entry else None

    def get_meeting_info(self, meeting_id: str) -> Optional[dict]:
        return self.meetings.get(meeting_id)

    def list_meetings(self) -> List[dict]:
        result = []
        for mid, entry in self.meetings.items():
            meeting: AITourMeeting = entry["meeting"]
            runtime = self._runtime_for(mid)
            elapsed_seconds = (
                self._runtime_elapsed_seconds(runtime)
                if runtime is not None
                else int(entry.get("elapsed_seconds", 0) or 0)
            )
            result.append(
                {
                    "id": mid,
                    "title": entry["title"],
                    "created_at": entry["created_at"],
                    "participant_count": len(meeting.participants),
                    "include_human": entry.get("include_human", False),
                    "human_name": entry.get("human_name") or "You",
                    "human_avatar": entry.get("human_avatar"),
                    "human_role": entry.get("human_role") or "attendee",
                    "has_history": len(self._serialize_history(meeting)) > 1,
                    "status": entry.get("status", "idle"),
                    "status_detail": entry.get("status_detail"),
                    "travel_date": entry.get("travel_date"),
                    "time_window_start": entry.get("time_window_start"),
                    "time_window_end": entry.get("time_window_end"),
                    "budget": entry.get("budget"),
                    "initialization_turn_rule": entry.get("initialization_turn_rule", "round_robin"),
                    "initialization_voting_rule": entry.get("initialization_voting_rule", "majority"),
                    "volunteer_mode": entry.get("volunteer_mode", False),
                    "balanced_turns": entry.get("balanced_turns", True),
                    "vote_settings_linked": entry.get("vote_settings_linked", True),
                    "vote_turn_rule": entry.get("vote_turn_rule"),
                    "single_decider": entry.get("single_decider"),
                    "elapsed_seconds": elapsed_seconds,
                }
            )
        # Sort by created_at descending (newest first)
        result.sort(key=lambda x: x["created_at"], reverse=True)
        return result

    def delete_meeting(self, meeting_id: str) -> bool:
        if meeting_id in self.meetings:
            del self.meetings[meeting_id]
            self.save()
            return True
        return False

    def update_global_goal(self, meeting_id: str, goal: str) -> str:
        entry = self.meetings.get(meeting_id)
        if not entry:
            raise KeyError(meeting_id)

        normalized = goal.strip()
        if not normalized:
            normalized = DEFAULT_GLOBAL_GOAL

        entry["global_goal"] = normalized
        self.save()
        return normalized

    def _runtime_for(self, meeting_id: str) -> Optional[MeetingRuntime]:
        runtime = self.active_runs.get(meeting_id)
        if runtime and runtime.task and runtime.task.done():
            self.active_runs.pop(meeting_id, None)
            runtime = None
        return runtime

    def _ensure_runtime(
        self,
        meeting_id: str,
        goal: str,
        max_turns: int,
        time_limit: Optional[int],
        resume_from_history: bool = False,
    ) -> MeetingRuntime:
        runtime = self._runtime_for(meeting_id)
        if runtime is None:
            info = self.get_meeting_info(meeting_id)
            runtime = MeetingRuntime(
                meeting_id=meeting_id,
                goal=goal,
                max_turns=max_turns,
                time_limit=time_limit,
                status="idle",
                accumulated=float((info or {}).get("elapsed_seconds", 0) or 0),
            )
            self.active_runs[meeting_id] = runtime
        else:
            runtime.goal = goal
            runtime.max_turns = max_turns
            runtime.time_limit = time_limit
        runtime.resume_from_history = resume_from_history
        return runtime

    def _remove_subscriber(self, meeting_id: str, queue: asyncio.Queue) -> None:
        runtime = self.active_runs.get(meeting_id)
        if not runtime:
            return
        runtime.queues.discard(queue)

    def _runtime_elapsed_seconds(self, runtime: MeetingRuntime) -> int:
        total = runtime.accumulated
        if runtime.started_at is not None:
            total += time.monotonic() - runtime.started_at
        return int(total)

    def _broadcast(self, meeting_id: str, payload: dict) -> None:
        runtime = self.active_runs.get(meeting_id)
        if not runtime:
            return
        runtime.buffer.append(payload)
        dead: List[asyncio.Queue] = []
        for queue in list(runtime.queues):
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                dead.append(queue)
        for queue in dead:
            runtime.queues.discard(queue)

    def _broadcast_status(self, meeting_id: str) -> None:
        runtime = self.active_runs.get(meeting_id)
        if not runtime:
            return
        payload = {
            "type": "status",
            "meeting_id": meeting_id,
            "status": runtime.status,
            "reason": runtime.reason,
            "elapsed": self._runtime_elapsed_seconds(runtime),
        }
        self._broadcast(meeting_id, payload)

    def _broadcast_error(self, meeting_id: str, message: str) -> None:
        logger.error("Meeting %s error: %s", meeting_id, message)
        payload = {
            "type": "error",
            "meeting_id": meeting_id,
            "message": message,
        }
        self._broadcast(meeting_id, payload)

    def _close_runtime_stream(self, meeting_id: str) -> None:
        runtime = self.active_runs.get(meeting_id)
        if not runtime:
            return
        close_payload = {"type": "stream_closed", "meeting_id": meeting_id}
        self._broadcast(meeting_id, close_payload)
        for queue in list(runtime.queues):
            try:
                queue.put_nowait({"type": "close"})
            except asyncio.QueueFull:
                pass
        runtime.queues.clear()

    def unsubscribe_meeting_stream(
        self, meeting_id: str, queue: Optional[asyncio.Queue]
    ) -> None:
        if queue is None:
            return
        self._remove_subscriber(meeting_id, queue)

    def _event_to_payload(
        self, event: MeetingEvent, include_human: bool
    ) -> Optional[dict]:
        if isinstance(event, MeetingStarted):
            return {
                "type": "meeting_started",
                "goal": event.goal,
                "include_human": include_human,
            }
        if isinstance(event, TurnStart):
            return {"type": "turn_start", "turn": event.turn, "speaker": event.speaker}
        if isinstance(event, Delta):
            payload = {
                "type": "delta",
                "turn": event.turn,
                "speaker": event.speaker,
                "delta": event.delta,
            }
            if event.metadata:
                payload["metadata"] = event.metadata
            return payload
        if isinstance(event, TurnFinal):
            payload = {
                "type": "turn_final",
                "turn": event.turn,
                "speaker": event.speaker,
                "text": event.text,
            }
            if event.route_plan:
                payload["route_plan"] = event.route_plan
            if event.steps_log:
                payload["steps_log"] = event.steps_log
            if event.steps_label:
                payload["steps_label"] = event.steps_label
            if event.max_steps is not None:
                payload["max_steps"] = event.max_steps
            if event.score is not None:
                payload["score"] = event.score
            logger.info(
                "[TurnFinal] speaker=%s steps_label=%s score=%s payload_has_score=%s",
                event.speaker, event.steps_label, event.score, "score" in payload,
            )
            return payload
        if isinstance(event, HumanTurn):
            return {
                "type": "human_turn",
                "turn": event.turn,
                "step": event.step,
                "max_steps": event.max_steps,
                "candidates": event.candidates,
                "can_ask": event.can_ask,
                "can_propose": event.can_propose,
                "current_route": event.current_route,
            }
        if isinstance(event, HumanVote):
            return {
                "type": "human_vote",
                "turn": event.turn,
                "vote_type": event.vote_type,
                "options": event.options,
                "step": event.step,
                "max_steps": event.max_steps,
                "candidates": event.candidates,
                "can_ask": event.can_ask,
            }
        if isinstance(event, HumanSelectSpeaker):
            return {
                "type": "human_select_speaker",
                "turn": event.turn,
                "speaker": event.speaker,
                "candidates": event.candidates,
            }
        if isinstance(event, HumanAsk):
            return {
                "type": "human_ask",
                "turn": event.turn,
                "asker": event.asker,
                "target": event.target,
                "question": event.question,
            }
        if isinstance(event, PhaseMessage):
            return {
                "type": "phase_message",
                "title": event.title,
                "description": event.description,
            }
        if isinstance(event, DeadlockIntervention):
            return {
                "type": "deadlock_intervention",
                "turn": event.turn,
                "message": event.message,
                "signals": event.signals,
            }
        if isinstance(event, RoutePlanUpdate):
            return {
                "type": "route_plan_update",
                "turn": event.turn,
                "speaker": event.speaker,
                "route_plan": event.route_plan,
            }
        if isinstance(event, RetryNotification):
            return {
                "type": "retry_notification",
                "turn": event.turn,
                "speaker": event.speaker,
                "attempt": event.attempt,
                "max_attempts": event.max_attempts,
                "error_message": event.error_message,
            }
        if isinstance(event, AskPending):
            return {
                "type": "ask_pending",
                "turn": event.turn,
                "asker": event.asker,
                "target": event.target,
                "question": event.question,
            }
        if isinstance(event, AskExchange):
            return {
                "type": "ask_exchange",
                "turn": event.turn,
                "asker": event.asker,
                "target": event.target,
                "question": event.question,
                "response": event.response,
            }
        if isinstance(event, ProposalVoteResult):
            return {
                "type": "proposal_vote_result",
                "turn": event.turn,
                "proposer": event.proposer,
                "accepted": event.accepted,
                "vote_summary": event.vote_summary,
            }
        if isinstance(event, SatisfiedUpdate):
            return {
                "type": "satisfied_update",
                "turn": event.turn,
                "speaker": event.speaker,
                "satisfied": event.satisfied,
                "satisfied_count": event.satisfied_count,
                "total_count": event.total_count,
            }
        if isinstance(event, RoundEnd):
            return {"type": "round_end", "round_number": event.round_number}
        if isinstance(event, Timeout):
            return {"type": "timeout"}
        if isinstance(event, MeetingFinished):
            return {"type": "meeting_finished", "turns": event.turns}
        return None

    async def _run_meeting(
        self,
        meeting_id: str,
        goal: str,
        max_turns: int,
        time_limit: Optional[int],
        resume_from_history: bool = False,
    ) -> None:
        info = self.get_meeting_info(meeting_id)
        if not info:
            return
        meeting: AITourMeeting = info["meeting"]
        runtime = self.active_runs.get(meeting_id)
        if runtime is None:
            return

        include_human = info.get("include_human", False)
        if include_human:
            meeting.enable_human(name=info.get("human_name") or "You")
        meeting.set_order(_engine_order(info))

        if runtime.started_at is None:
            runtime.started_at = time.monotonic()

        runtime.status = "running"
        runtime.reason = None
        info["status"] = "running"
        info["status_detail"] = None
        self.save()
        self._broadcast_status(meeting_id)

        runtime.mode = "free_conversation"

        try:
            # Resolve effective vote turn rule
            conv_turn_rule = info.get("initialization_turn_rule", "round_robin")
            vote_linked = info.get("vote_settings_linked", True)
            effective_vote_turn_rule = (
                conv_turn_rule if vote_linked
                else info.get("vote_turn_rule", conv_turn_rule)
            )

            # Resolve the single-decider participant id to its engine name
            # ("__YOU__" passes through as the human sentinel).
            single_decider_name: Optional[str] = None
            decider_id = info.get("single_decider")
            if decider_id == "__YOU__":
                single_decider_name = "__YOU__"
            elif decider_id:
                decider_cfg = next(
                    (
                        c for c in info.get("participants_config", [])
                        if c.get("id") == decider_id
                    ),
                    None,
                )
                if decider_cfg and decider_cfg.get("engine_name"):
                    single_decider_name = decider_cfg["engine_name"]

            # Build title and constraints for system prompt
            meeting_title = info.get("title", "Untitled Meeting")
            constraints_dict = {}
            if info.get("travel_date"):
                constraints_dict["travel_date"] = info["travel_date"]
            if info.get("time_window_start"):
                constraints_dict["time_window_start"] = info["time_window_start"]
            if info.get("time_window_end"):
                constraints_dict["time_window_end"] = info["time_window_end"]
            if info.get("budget"):
                constraints_dict["budget"] = info["budget"]

            event_stream = meeting.run_free_conversation(
                goal,
                turn_rule=conv_turn_rule,
                voting_rule=info.get("initialization_voting_rule", "majority"),
                resume_from_history=resume_from_history,
                max_turns=max_turns,
                time_limit=time_limit,
                volunteer_mode=info.get("volunteer_mode", False),
                balanced_turns=info.get("balanced_turns", True),
                vote_turn_rule=effective_vote_turn_rule,
                single_decider=single_decider_name,
                human_role=info.get("human_role", "attendee"),
                title=meeting_title,
                constraints=constraints_dict,
            )
            async for event in event_stream:
                payload = self._event_to_payload(event, include_human)
                if payload:
                    self._broadcast(meeting_id, payload)

                if isinstance(event, Timeout):
                    runtime.status = "timeout"
                    runtime.reason = "Time limit reached"
                    info["status"] = runtime.status
                    info["status_detail"] = runtime.reason
                    self._broadcast_status(meeting_id)
                elif isinstance(event, MeetingFinished):
                    if runtime.status not in {"timeout", "error", "stopped"}:
                        if (
                            runtime.mode == "discussion"
                            and max_turns
                            and event.turns >= max_turns
                        ):
                            runtime.reason = "Max turns reached"
                        else:
                            runtime.reason = None
                        runtime.status = "finished"
                        info["status"] = runtime.status
                        info["status_detail"] = runtime.reason
        except asyncio.CancelledError:
            runtime.status = "stopped"
            runtime.reason = "Cancelled"
            info["status"] = runtime.status
            info["status_detail"] = runtime.reason
            self._broadcast_status(meeting_id)
            raise
        except Exception as exc:
            runtime.status = "error"
            runtime.reason = f"{type(exc).__name__}: {exc}"
            info["status"] = runtime.status
            info["status_detail"] = runtime.reason
            logger.exception("Meeting %s encountered an error", meeting_id)
            self._broadcast_error(meeting_id, runtime.reason or "Unknown error")
            self._broadcast_status(meeting_id)
        finally:
            elapsed_total = self._runtime_elapsed_seconds(runtime)
            runtime.accumulated = elapsed_total
            runtime.started_at = None
            info["elapsed_seconds"] = elapsed_total
            if runtime.stop_requested and runtime.status not in {"timeout", "error"}:
                runtime.status = "stopped"
                runtime.reason = runtime.reason or "Stopped by user"
                info["status"] = runtime.status
                info["status_detail"] = runtime.reason

            self.save()
            self._broadcast_status(meeting_id)
            self._close_runtime_stream(meeting_id)
            runtime.task = None
            if runtime.status in {"finished", "timeout", "stopped", "error"}:
                self.active_runs.pop(meeting_id, None)

    def start_meeting_stream(
        self,
        meeting_id: str,
        goal: Optional[str],
        max_turns: int,
        time_limit: Optional[int],
    ) -> Tuple[asyncio.Queue, List[dict], str, Optional[str], int]:
        info = self.get_meeting_info(meeting_id)
        if not info:
            raise KeyError(meeting_id)

        normalized_goal = goal.strip() if isinstance(goal, str) else ""
        if normalized_goal:
            normalized_goal = self.update_global_goal(meeting_id, normalized_goal)
        else:
            normalized_goal = info.get("global_goal", DEFAULT_GLOBAL_GOAL)

        meeting_obj: AITourMeeting = info["meeting"]

        info["max_turns"] = max_turns if max_turns > 0 else info.get("max_turns", 100)
        info["time_limit"] = time_limit if time_limit and time_limit > 0 else None
        existing_turns = 0
        for msg in getattr(meeting_obj, "history", []):
            existing_turns += 1
        resume_from_history = info.get("status") == "stopped" and existing_turns > 0
        self.save()

        runtime = self._ensure_runtime(
            meeting_id,
            normalized_goal,
            info.get("max_turns", 100),
            info.get("time_limit"),
            resume_from_history=resume_from_history,
        )

        queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        runtime.queues.add(queue)

        if not runtime.task or runtime.task.done():
            runtime.status = "running"
            runtime.reason = None
            runtime.stop_requested = False
            if not resume_from_history:
                runtime.buffer.clear()
                runtime.accumulated = 0.0
            runtime.started_at = time.monotonic()
            info["status"] = "running"
            info["status_detail"] = None
            runtime.task = asyncio.create_task(
                self._run_meeting(
                    meeting_id,
                    runtime.goal,
                    runtime.max_turns,
                    runtime.time_limit,
                    resume_from_history=resume_from_history,
                )
            )
            self.save()
            self._broadcast_status(meeting_id)

        return (
            queue,
            runtime.snapshot_buffer(),
            runtime.status,
            runtime.reason,
            self._runtime_elapsed_seconds(runtime),
        )

    def subscribe_meeting_stream(
        self, meeting_id: str
    ) -> Tuple[Optional[asyncio.Queue], List[dict], str, Optional[str], int]:
        runtime = self._runtime_for(meeting_id)
        info = self.get_meeting_info(meeting_id)
        status = info.get("status", "idle") if info else "idle"
        detail = info.get("status_detail") if info else None
        if not runtime:
            return None, [], status, detail, 0
        queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        runtime.queues.add(queue)
        return (
            queue,
            runtime.snapshot_buffer(),
            runtime.status,
            runtime.reason,
            self._runtime_elapsed_seconds(runtime),
        )

    def submit_human_input(self, meeting_id: str, message: Any) -> None:
        info = self.get_meeting_info(meeting_id)
        if not info:
            return
        meeting: AITourMeeting = info["meeting"]
        meeting.submit_human(message)

    def submit_human_vote(self, meeting_id: str, vote_data: Dict[str, Any]) -> None:
        info = self.get_meeting_info(meeting_id)
        if not info:
            return
        meeting: AITourMeeting = info["meeting"]
        meeting.submit_human_vote(vote_data)

    def submit_human_selection(self, meeting_id: str, speaker: str) -> None:
        info = self.get_meeting_info(meeting_id)
        if not info:
            return
        meeting: AITourMeeting = info["meeting"]
        meeting.submit_human_selection(speaker)

    def submit_human_ask_answer(self, meeting_id: str, answer: str) -> None:
        info = self.get_meeting_info(meeting_id)
        if not info:
            return
        meeting: AITourMeeting = info["meeting"]
        meeting.submit_human_ask_answer(answer)

    def stop_meeting_runtime(self, meeting_id: str) -> bool:
        runtime = self._runtime_for(meeting_id)
        info = self.get_meeting_info(meeting_id)
        if not runtime or not info:
            return False
        runtime.stop_requested = True
        runtime.reason = "Stopped by user"
        meeting: AITourMeeting = info["meeting"]
        try:
            meeting.stop()
        except Exception:
            pass
        runtime.status = "stopping"
        info["status"] = "stopping"
        info["status_detail"] = runtime.reason
        elapsed_total = self._runtime_elapsed_seconds(runtime)
        runtime.accumulated = elapsed_total
        runtime.started_at = None
        info["elapsed_seconds"] = elapsed_total
        self._broadcast_status(meeting_id)
        self.save()
        # Watchdog: the graceful stop relies on the run loop noticing the stop
        # event; if the task is still alive after the grace period (a turn that
        # drags on, or a wait the event can't unblock), cancel it outright. The
        # CancelledError handler in _run_meeting settles the status to stopped.
        task = runtime.task
        if task is not None and not task.done():
            def _force_cancel() -> None:
                if not task.done():
                    logger.warning(
                        "Meeting %s did not stop within %ss; cancelling its run task",
                        meeting_id, STOP_GRACE_SECONDS,
                    )
                    task.cancel()
            try:
                asyncio.get_running_loop().call_later(STOP_GRACE_SECONDS, _force_cancel)
            except RuntimeError:
                pass
        return True

#------------- 
# FastAPI app
#------------- 
app = FastAPI(title="AI Tour Meeting API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

STORE = MeetingStore()

# Initialize with one default meeting if none exist
if not STORE.meetings:
    default_id = STORE.create_meeting("Meeting 1")
else:
    default_id = next(iter(STORE.meetings.keys()))

@app.post("/meetings", response_model=MeetingOut)
def create_meeting(body: MeetingCreate):
    meeting_id = STORE.create_meeting(body.title)
    info = STORE.get_meeting_info(meeting_id)
    return MeetingOut(
        id=meeting_id,
        title=info["title"],
        created_at=info["created_at"],
        participant_count=0,
        include_human=info.get("include_human", False),
        human_name=info.get("human_name") or "You",
        human_avatar=info.get("human_avatar"),
        human_role=info.get("human_role") or "attendee",
        has_history=False,
        status=info.get("status", "idle"),
        status_detail=info.get("status_detail"),
        travel_date=info.get("travel_date"),
        time_window=info.get("time_window"),
        budget=info.get("budget"),
        initialization_turn_rule=info.get("initialization_turn_rule", "round_robin"),
        initialization_voting_rule=info.get("initialization_voting_rule", "majority"),
        volunteer_mode=info.get("volunteer_mode", False),
        balanced_turns=info.get("balanced_turns", True),
        vote_turn_rule=info.get("vote_turn_rule"),
        vote_settings_linked=info.get("vote_settings_linked", True),
        single_decider=info.get("single_decider"),
    )

@app.post("/meetings/{meeting_id}/duplicate", response_model=MeetingOut)
def duplicate_meeting(meeting_id: str, body: MeetingCreate):
    source = STORE.get_meeting_info(meeting_id)
    if not source:
        raise HTTPException(404, detail="Meeting not found")

    source_title = source.get("title", "Meeting")
    requested_title = (body.title or "").strip()
    new_title = requested_title or f"Copy of {source_title}"

    new_meeting_id = STORE.create_meeting(new_title)
    target = STORE.get_meeting_info(new_meeting_id)
    if not target:
        raise HTTPException(500, detail="Failed to create duplicated meeting")

    target_meeting: AITourMeeting = target["meeting"]

    # Copy meeting-level settings stored in meetings.json (without run status/history).
    target["global_goal"] = source.get("global_goal", DEFAULT_GLOBAL_GOAL)
    target["max_turns"] = source.get("max_turns", 100)
    target["time_limit"] = source.get("time_limit")
    target["travel_date"] = source.get("travel_date")
    target["time_window_start"] = source.get("time_window_start")
    target["time_window_end"] = source.get("time_window_end")
    target["budget"] = source.get("budget")
    target["initialization_turn_rule"] = source.get("initialization_turn_rule", "round_robin")
    target["initialization_voting_rule"] = source.get("initialization_voting_rule", "majority")
    target["volunteer_mode"] = bool(source.get("volunteer_mode", False))
    target["balanced_turns"] = bool(source.get("balanced_turns", True))
    target["vote_settings_linked"] = bool(source.get("vote_settings_linked", True))
    target["single_decider"] = source.get("single_decider")
    if source.get("vote_turn_rule") is not None:
        target["vote_turn_rule"] = source.get("vote_turn_rule")
    elif "vote_turn_rule" in target:
        del target["vote_turn_rule"]

    include_human = bool(source.get("include_human", False))
    target["include_human"] = include_human
    target["human_name"] = source.get("human_name") or "You"
    target["human_avatar"] = source.get("human_avatar")
    target["human_role"] = source.get("human_role") or "attendee"
    if include_human:
        target_meeting.enable_human(name=target["human_name"])

    # Recreate participants from stored participant config.
    source_configs = source.get("participants_config", []) or []
    copied_configs: List[dict] = []
    for cfg in source_configs:
        try:
            normalized_cfg = ParticipantIn(**cfg).model_dump()
            if not normalized_cfg.get("id"):
                normalized_cfg["id"] = _new_participant_id()
            if normalized_cfg.get("incomplete"):
                # Drafts are copied as config-only entries, never as personas.
                normalized_cfg["engine_name"] = None
                copied_configs.append(normalized_cfg)
                continue
            llm = load_llm(
                model_name=normalized_cfg.get("model_name", "openai/gpt-5.4-mini"),
                temperature=normalized_cfg.get("temperature", 0.7),
                seed=normalized_cfg.get("seed", 42),
                max_tokens=normalized_cfg.get("max_tokens"),
                max_context_length=normalized_cfg.get("max_context_length"),
                reasoning_effort=_effective_reasoning_effort(
                    normalized_cfg.get("model_name", ""),
                    normalized_cfg.get("reasoning_effort"),
                ),
            )
            engine_name = normalized_cfg.get("engine_name") or _unique_engine_name(
                target_meeting, normalized_cfg.get("name", "")
            )
            normalized_cfg["engine_name"] = engine_name
            participant = Participant(
                llm=llm,
                name=engine_name,
                background=normalized_cfg.get("background", ""),
                personality=normalized_cfg.get("personality", ""),
                preferences=normalized_cfg.get("preferences", ""),
                personal_goals=normalized_cfg.get("personal_goals", ""),
                role=normalized_cfg.get("role", "attendee"),
                speaking_style=normalized_cfg.get("speaking_style", "friendly"),
                explanation_style=normalized_cfg.get("explanation_style", "auto"),
                web_search=normalized_cfg.get("web_search", True),
                max_steps=normalized_cfg.get("max_steps", 5),
                context_mode=normalized_cfg.get("context_mode", "auto_compact"),
                auto_compact_threshold=normalized_cfg.get("auto_compact_threshold", 0.8),
                auto_compact_target=normalized_cfg.get("auto_compact_target", 0.5),
                compact_recent_ratio=normalized_cfg.get("compact_recent_ratio", 0.7),
                fixed_turns_count=normalized_cfg.get("fixed_turns_count", 10),
                system_prompt=normalized_cfg.get("system_prompt"),
            )
            target_meeting.add_participant(participant)
            copied_configs.append(normalized_cfg)
        except Exception:
            logger.exception("Failed to duplicate participant '%s' for meeting %s", cfg.get("name", ""), meeting_id)

    target["participants_config"] = copied_configs

    # Preserve participant order (including __YOU__) as much as possible.
    valid_ids = {cfg.get("id") for cfg in copied_configs}
    if include_human:
        valid_ids.add("__YOU__")
    source_order = source.get("order", []) or []
    new_order = [x for x in source_order if x in valid_ids]
    for cfg in copied_configs:
        if cfg["id"] not in new_order:
            new_order.append(cfg["id"])
    if include_human and "__YOU__" not in new_order:
        new_order.append("__YOU__")
    target["order"] = new_order
    target_meeting.set_order(_engine_order(target))

    STORE.save()

    return MeetingOut(
        id=new_meeting_id,
        title=target["title"],
        created_at=target["created_at"],
        participant_count=len(target_meeting.participants),
        include_human=target.get("include_human", False),
        human_name=target.get("human_name") or "You",
        human_avatar=target.get("human_avatar"),
        human_role=target.get("human_role") or "attendee",
        has_history=False,
        status=target.get("status", "idle"),
        status_detail=target.get("status_detail"),
        travel_date=target.get("travel_date"),
        time_window_start=target.get("time_window_start"),
        time_window_end=target.get("time_window_end"),
        budget=target.get("budget"),
        initialization_turn_rule=target.get("initialization_turn_rule", "round_robin"),
        initialization_voting_rule=target.get("initialization_voting_rule", "majority"),
        volunteer_mode=target.get("volunteer_mode", False),
        balanced_turns=target.get("balanced_turns", True),
        vote_turn_rule=target.get("vote_turn_rule"),
        vote_settings_linked=target.get("vote_settings_linked", True),
        single_decider=target.get("single_decider"),
    )

@app.get("/meetings", response_model=List[MeetingOut])
def list_meetings():
    meetings = STORE.list_meetings()
    return [
        MeetingOut(
            id=m["id"],
            title=m["title"],
            created_at=m["created_at"],
            participant_count=m["participant_count"],
            include_human=m.get("include_human", False),
            human_name=m.get("human_name") or "You",
            human_avatar=m.get("human_avatar"),
            human_role=m.get("human_role") or "attendee",
            has_history=m.get("has_history", False),
            status=m.get("status", "idle"),
            status_detail=m.get("status_detail"),
            travel_date=m.get("travel_date"),
            time_window_start=m.get("time_window_start"),
            time_window_end=m.get("time_window_end"),
            budget=m.get("budget"),
            initialization_turn_rule=m.get("initialization_turn_rule", "round_robin"),
            initialization_voting_rule=m.get("initialization_voting_rule", "majority"),
            volunteer_mode=m.get("volunteer_mode", False),
            balanced_turns=m.get("balanced_turns", True),
            vote_turn_rule=m.get("vote_turn_rule"),
            vote_settings_linked=m.get("vote_settings_linked", True),
            single_decider=m.get("single_decider"),
            elapsed_seconds=m.get("elapsed_seconds", 0),
        )
        for m in meetings
    ]

@app.delete("/meetings/{meeting_id}")
def delete_meeting(meeting_id: str):
    if STORE.delete_meeting(meeting_id):
        return {"ok": True}
    raise HTTPException(404, detail="Meeting not found")

@app.get("/meetings/{meeting_id}")
def get_meeting(meeting_id: str):
    info = STORE.get_meeting_info(meeting_id)
    if not info:
        raise HTTPException(404, detail="Meeting not found")

    runtime = STORE._runtime_for(meeting_id)
    elapsed_seconds = (
        STORE._runtime_elapsed_seconds(runtime)
        if runtime is not None
        else int(info.get("elapsed_seconds", 0) or 0)
    )
    return {
        "id": meeting_id,
        "title": info["title"],
        "created_at": info["created_at"],
        "participant_count": len(info["meeting"].participants),
        "include_human": info.get("include_human", False),
        "human_name": info.get("human_name") or "You",
        "human_avatar": info.get("human_avatar"),
        "human_role": info.get("human_role") or "attendee",
        "has_history": len(STORE._serialize_history(info["meeting"])) > 1,
        "max_turns": info.get("max_turns", 100),
        "time_limit": info.get("time_limit"),
        "travel_date": info.get("travel_date"),
        "time_window_start": info.get("time_window_start"),
        "time_window_end": info.get("time_window_end"),
        "budget": info.get("budget"),
        "status": info.get("status", "idle"),
        "status_detail": info.get("status_detail"),
        "initialization_turn_rule": info.get("initialization_turn_rule", "round_robin"),
        "initialization_voting_rule": info.get("initialization_voting_rule", "majority"),
        "volunteer_mode": info.get("volunteer_mode", False),
        "balanced_turns": info.get("balanced_turns", True),
        "vote_turn_rule": info.get("vote_turn_rule"),
        "vote_settings_linked": info.get("vote_settings_linked", True),
        "single_decider": info.get("single_decider"),
        "elapsed_seconds": elapsed_seconds,
    }

@app.patch("/meetings/{meeting_id}")
def update_meeting(meeting_id: str, body: MeetingUpdate):
    info = STORE.get_meeting_info(meeting_id)
    if not info:
        raise HTTPException(404, detail="Meeting not found")
    
    meeting = info["meeting"]
    payload = body.model_dump(exclude_unset=True)
    order = info.setdefault("order", [])

    if "title" in payload and payload["title"] is not None:
        info["title"] = payload["title"]

    # Validate human_* fields up-front so a rejected role doesn't leave a
    # partially-applied name/avatar in memory (all-or-nothing for this PATCH).
    if "human_name" in payload and payload["human_name"] is not None:
        human_name = str(payload["human_name"]).strip()
        if not human_name:
            raise HTTPException(400, detail="human_name must not be empty")
        taken_names = set()
        for cfg in info.get("participants_config", []):
            for key in ("name", "engine_name"):
                value = (cfg.get(key) or "").strip()
                if value:
                    taken_names.add(value)
        if human_name in taken_names:
            raise HTTPException(400, detail="human_name conflicts with an existing participant")
    else:
        human_name = None

    if "human_role" in payload and payload["human_role"] is not None:
        if payload["human_role"] not in HUMAN_ROLE_OPTIONS:
            raise HTTPException(400, detail="Unsupported human_role")

    if human_name is not None:
        info["human_name"] = human_name
        if getattr(meeting, "_human_enabled", False):
            meeting._human_name = human_name  # type: ignore[attr-defined]

    if "human_avatar" in payload:
        info["human_avatar"] = payload["human_avatar"]

    if "human_role" in payload and payload["human_role"] is not None:
        info["human_role"] = payload["human_role"]

    if "include_human" in payload:
        include_human = payload["include_human"]
        info["include_human"] = include_human
        if include_human and not getattr(meeting, "_human_enabled", False):
            meeting.enable_human(name=info.get("human_name") or "You")
        if include_human is False:
            meeting._human_enabled = False  # type: ignore[attr-defined]
            meeting._human_queue = None  # type: ignore[attr-defined]
            meeting._order = [x for x in meeting._order if x != "__YOU__"]  # type: ignore[attr-defined]
            if info.get("single_decider") == "__YOU__":
                info["single_decider"] = None

    if info.get("include_human"):
        if "__YOU__" not in order:
            order.append("__YOU__")
    else:
        info["order"] = [x for x in order if x != "__YOU__"]
        order = info["order"]

    info["order"] = order

    if "max_turns" in payload and payload["max_turns"] is not None:
        max_turns = int(payload["max_turns"])
        if max_turns <= 0:
            raise HTTPException(400, detail="max_turns must be positive")
        info["max_turns"] = max_turns

    if "time_limit" in payload:
        raw_time_limit = payload["time_limit"]
        if raw_time_limit is None:
            info["time_limit"] = None
        else:
            time_limit = int(raw_time_limit)
            if time_limit <= 0:
                raise HTTPException(400, detail="time_limit must be positive")
            info["time_limit"] = time_limit

    if "travel_date" in payload:
        info["travel_date"] = payload["travel_date"]

    if "time_window_start" in payload:
        info["time_window_start"] = payload["time_window_start"]

    if "time_window_end" in payload:
        info["time_window_end"] = payload["time_window_end"]

    if "budget" in payload:
        info["budget"] = payload["budget"]

    if "initialization_turn_rule" in payload and payload["initialization_turn_rule"] is not None:
        turn_rule_value = payload["initialization_turn_rule"]
        if turn_rule_value not in TURN_RULE_OPTIONS:
            raise HTTPException(400, detail="Unsupported turn rule")
        info["initialization_turn_rule"] = turn_rule_value

    if "initialization_voting_rule" in payload and payload["initialization_voting_rule"] is not None:
        voting_rule_value = payload["initialization_voting_rule"]
        if voting_rule_value not in VOTING_RULE_OPTIONS:
            raise HTTPException(400, detail="Unsupported voting rule")
        info["initialization_voting_rule"] = voting_rule_value

    if "volunteer_mode" in payload and payload["volunteer_mode"] is not None:
        info["volunteer_mode"] = bool(payload["volunteer_mode"])

    if "balanced_turns" in payload and payload["balanced_turns"] is not None:
        info["balanced_turns"] = bool(payload["balanced_turns"])

    requested_linked = payload.get("vote_settings_linked")
    if requested_linked is not None:
        requested_linked = bool(requested_linked)
        info["vote_settings_linked"] = requested_linked
        if requested_linked:
            info.pop("vote_turn_rule", None)

    if "vote_turn_rule" in payload and payload["vote_turn_rule"] is not None:
        vote_turn_rule_value = payload["vote_turn_rule"]
        if vote_turn_rule_value not in VOTE_TURN_RULE_OPTIONS:
            raise HTTPException(400, detail="Unsupported vote turn rule")
        effective_linked = bool(info.get("vote_settings_linked", True))
        if effective_linked:
            raise HTTPException(400, detail="vote_turn_rule can be set only when vote_settings_linked is false")
        info["vote_turn_rule"] = vote_turn_rule_value

    if "single_decider" in payload:
        decider_value = payload["single_decider"]
        if decider_value is not None:
            valid_ids = {
                c.get("id") for c in info.get("participants_config", []) if c.get("id")
            }
            if info.get("include_human"):
                valid_ids.add("__YOU__")
            if decider_value not in valid_ids:
                raise HTTPException(400, detail="single_decider must be an existing participant id")
        info["single_decider"] = decider_value

    STORE.save()
    return {
        "ok": True,
        "title": info["title"],
        "include_human": info.get("include_human", False),
        "human_name": info.get("human_name") or "You",
        "human_avatar": info.get("human_avatar"),
        "human_role": info.get("human_role") or "attendee",
        "max_turns": info.get("max_turns", 100),
        "time_limit": info.get("time_limit"),
        "status": info.get("status", "idle"),
        "status_detail": info.get("status_detail"),
        "initialization_turn_rule": info.get("initialization_turn_rule", "round_robin"),
        "initialization_voting_rule": info.get("initialization_voting_rule", "majority"),
        "volunteer_mode": info.get("volunteer_mode", False),
        "balanced_turns": info.get("balanced_turns", True),
        "vote_turn_rule": info.get("vote_turn_rule"),
        "vote_settings_linked": info.get("vote_settings_linked", True),
        "single_decider": info.get("single_decider"),
    }

@app.post("/meetings/{meeting_id}/participants", response_model=dict)
def add_participant(meeting_id: str, p: ParticipantIn):
    """Create a participant, or update one in place when `id` matches."""
    meeting = STORE.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(404, detail="Meeting not found")

    # A participant without a name can only exist as a draft.
    if not p.name.strip():
        p.incomplete = True

    info = STORE.get_meeting_info(meeting_id)
    configs = info.setdefault("participants_config", []) if info is not None else []
    order = info.setdefault("order", []) if info is not None else []
    existing = next((c for c in configs if p.id and c.get("id") == p.id), None)
    if not p.id:
        p.id = _new_participant_id()

    # When updating, retire the old persona before picking the engine name so
    # an unchanged name doesn't collide with itself.
    if existing and existing.get("engine_name"):
        meeting.participants = [
            x for x in meeting.participants if x.name != existing["engine_name"]
        ]

    # Incomplete drafts are stored in the config only; they are not turned
    # into a live persona and take no part in the meeting run.
    _spawn_persona(meeting, p)

    if info is not None:
        participant_config = p.model_dump()
        if existing is not None:
            configs[configs.index(existing)] = participant_config
            if p.id not in order:
                order.append(p.id)
        else:
            configs.append(participant_config)
            if "__YOU__" in order:
                idx = order.index("__YOU__")
                order.insert(idx + 1, p.id)
            else:
                order.append(p.id)
    STORE.save()
    return {"ok": True, "id": p.id, "count": len(meeting.participants)}


@app.post("/meetings/{meeting_id}/participants/{participant_id}/duplicate", response_model=dict)
def duplicate_participant(meeting_id: str, participant_id: str):
    """Clone a participant, inserting the copy right after the original."""
    meeting = STORE.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(404, detail="Meeting not found")

    info = STORE.get_meeting_info(meeting_id)
    configs = info.setdefault("participants_config", []) if info is not None else []
    order = info.setdefault("order", []) if info is not None else []
    src = next((c for c in configs if c.get("id") == participant_id), None)
    if src is None:
        raise HTTPException(404, detail="Participant not found")

    clone = ParticipantIn(**src)
    clone.id = _new_participant_id()
    # A fresh id means _spawn_persona picks its own unique engine name (the
    # duplicate keeps the same display name, so it becomes "Name (2)").
    _spawn_persona(meeting, clone)

    src_idx = configs.index(src)
    configs.insert(src_idx + 1, clone.model_dump())
    if participant_id in order:
        order.insert(order.index(participant_id) + 1, clone.id)
    else:
        order.append(clone.id)
    STORE.save()
    return {"ok": True, "id": clone.id, "count": len(meeting.participants)}


@app.post("/meetings/{meeting_id}/reset")
async def reset_meeting(meeting_id: str):
    info = STORE.get_meeting_info(meeting_id)
    if not info:
        raise HTTPException(404, detail="Meeting not found")

    meeting: AITourMeeting = info["meeting"]
    # Terminate any live run BEFORE meeting.reset(): reset swaps out the stop
    # event and human queues, which would orphan a running generator — it would
    # keep making LLM calls forever with no remaining way to stop it.
    runtime = STORE.active_runs.get(meeting_id)
    task = runtime.task if runtime else None
    if task is not None and not task.done():
        runtime.stop_requested = True
        try:
            meeting.stop()
        except Exception:
            pass
        task.cancel()
        try:
            await asyncio.wait_for(task, timeout=5)
        except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
            pass
    meeting.reset()
    meeting.history = []
    info["status"] = "idle"
    info["status_detail"] = None
    info["elapsed_seconds"] = 0
    runtime = STORE.active_runs.get(meeting_id)
    if runtime is not None and (runtime.task is None or runtime.task.done()):
        STORE.active_runs.pop(meeting_id, None)
    STORE.save()
    return {"ok": True}

@app.get("/meetings/{meeting_id}/participants", response_model=List[dict])
def list_participants(meeting_id: str):
    meeting = STORE.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(404, detail="Meeting not found")

    info = STORE.get_meeting_info(meeting_id)
    if info:
        configs = info.get("participants_config", [])
        if configs:
            normalized: List[dict] = []
            for cfg in configs:
                try:
                    normalized.append(ParticipantIn(**cfg).model_dump())
                except Exception:
                    logger.exception("Failed to normalize participant config for meeting %s", meeting_id)
            return normalized

    return [
        {
            "model_name": getattr(p.llm, "model", "unknown"),
            "temperature": getattr(p.llm, "temperature", 0.7),
            "seed": getattr(p.llm, "seed", 42),
            "max_tokens": getattr(p.llm, "max_tokens", None),
            "max_context_length": getattr(p.llm, "max_context_length", None),
            "context_mode": getattr(p, "context_mode", "auto_compact"),
            "auto_compact_threshold": getattr(p, "auto_compact_threshold", 0.8),
            "auto_compact_target": getattr(p, "auto_compact_target", 0.5),
            "fixed_turns_count": getattr(p, "fixed_turns_count", 10),
            "compact_recent_ratio": getattr(p, "compact_recent_ratio", 0.7),
            "name": p.name,
            "background": p.background,
            "personality": p.personality,
            "preferences": p.preferences,
            "personal_goals": p.personal_goals,
            "role": p.role,
            "speaking_style": p.speaking_style,
            "explanation_style": p.explanation_style,
            "web_search": p.web_search,
            "max_steps": getattr(p, "max_steps", 5),
            "system_prompt": getattr(p, "system_prompt", None),
        }
        for p in meeting.participants
    ]


@app.get("/meetings/{meeting_id}/participants/export", response_model=ParticipantsPayload)
def export_participants(meeting_id: str):
    meeting = STORE.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(404, detail="Meeting not found")

    info = STORE.get_meeting_info(meeting_id)
    data = list_participants(meeting_id)
    return ParticipantsPayload(participants=[ParticipantIn(**p) for p in data])


def _participant_exists(info: dict, payload: ParticipantIn) -> bool:
    configs = info.get("participants_config", [])
    if payload.id:
        return any(cfg.get("id") == payload.id for cfg in configs)
    # Legacy files carry no ids; fall back to name-based dedup on import.
    return any(cfg.get("name") == payload.name for cfg in configs)


def _add_participant_from_payload(info: dict, meeting: AITourMeeting, payload: ParticipantIn, insert_after_you: bool = True):
    if not payload.id:
        payload.id = _new_participant_id()
    if not payload.name.strip():
        payload.incomplete = True
    payload.engine_name = None
    if not payload.incomplete:
        llm = load_llm(
            model_name=payload.model_name,
            temperature=payload.temperature,
            seed=payload.seed,
            max_tokens=payload.max_tokens,
            max_context_length=payload.max_context_length,
            reasoning_effort=_effective_reasoning_effort(
                payload.model_name, payload.reasoning_effort
            ),
        )
        payload.engine_name = _unique_engine_name(meeting, payload.name)
        participant = Participant(
            llm=llm,
            name=payload.engine_name,
            background=payload.background,
            personality=payload.personality,
            preferences=payload.preferences,
            personal_goals=payload.personal_goals,
            role=payload.role,
            speaking_style=payload.speaking_style,
            explanation_style=payload.explanation_style,
            web_search=payload.web_search,
            max_steps=payload.max_steps,
            context_mode=payload.context_mode,
            auto_compact_threshold=payload.auto_compact_threshold,
            auto_compact_target=payload.auto_compact_target,
            fixed_turns_count=payload.fixed_turns_count,
            compact_recent_ratio=payload.compact_recent_ratio,
            system_prompt=payload.system_prompt,
        )
        meeting.add_participant(participant)
    order = info.setdefault("order", [])
    configs = info.setdefault("participants_config", [])
    configs.append(payload.model_dump())
    if insert_after_you and "__YOU__" in order:
        idx = order.index("__YOU__")
        order.insert(idx + 1, payload.id)
    else:
        order.append(payload.id)


@app.post("/meetings/{meeting_id}/participants/import")
def import_participants(meeting_id: str, body: ParticipantsPayload):
    info = STORE.get_meeting_info(meeting_id)
    meeting = STORE.get_meeting(meeting_id)
    if not info or not meeting:
        raise HTTPException(404, detail="Meeting not found")

    added = 0
    for participant_payload in body.participants:
        if _participant_exists(info, participant_payload):
            continue
        _add_participant_from_payload(info, meeting, participant_payload)
        added += 1

    if added:
        STORE.save()

    return {"added": added, "total": len(meeting.participants)}

@app.delete("/meetings/{meeting_id}/participants/{participant_key}")
def delete_participant(meeting_id: str, participant_key: str):
    """Delete a participant by id (preferred) or, for legacy callers, by name."""
    meeting = STORE.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(404, detail="Meeting not found")

    info = STORE.get_meeting_info(meeting_id)
    configs = info.get("participants_config", []) if info is not None else []
    cfg = next((c for c in configs if c.get("id") == participant_key), None)
    if cfg is None:
        cfg = next((c for c in configs if c.get("name") == participant_key), None)
    in_participants = any(p.name == participant_key for p in meeting.participants)
    if cfg is None and not in_participants:
        raise HTTPException(404, detail="Participant not found")

    engine_name = (cfg or {}).get("engine_name") or participant_key
    meeting.participants = [p for p in meeting.participants if p.name != engine_name]

    if info is not None and cfg is not None:
        removed = {participant_key, cfg.get("id")}
        info["order"] = [x for x in info.get("order", []) if x not in removed]
        info["participants_config"] = [c for c in configs if c is not cfg]
        if info.get("single_decider") in removed:
            info["single_decider"] = None
    STORE.save()
    return {"ok": True, "count": len(meeting.participants)}

@app.get("/meetings/{meeting_id}/goal")
def get_goal(meeting_id: str):
    info = STORE.get_meeting_info(meeting_id)
    if not info:
        raise HTTPException(404, detail="Meeting not found")

    goal = info.get("global_goal")
    if not isinstance(goal, str) or not goal.strip():
        meeting: AITourMeeting = info["meeting"]
        if meeting.history:
            first_msg = meeting.history[0]
            if (
                isinstance(first_msg, HumanMessage)
                and getattr(first_msg, "name", "") == "MeetingGoal"
            ):
                goal = first_msg.content
            else:
                goal = DEFAULT_GLOBAL_GOAL
        else:
            goal = DEFAULT_GLOBAL_GOAL
        info["global_goal"] = goal
        STORE.save()

    return {"goal": goal}

@app.patch("/meetings/{meeting_id}/goal")
def patch_goal(meeting_id: str, body: GoalUpdate):
    try:
        goal = STORE.update_global_goal(meeting_id, body.goal)
    except KeyError:
        raise HTTPException(404, detail="Meeting not found")
    return {"ok": True, "goal": goal}

def _build_name_display_map(meeting: AITourMeeting) -> Dict[str, str]:
    """Map sanitized names back to original participant display names."""
    result: Dict[str, str] = {}
    for p in meeting.participants:
        result[sanitize_name(p.name)] = p.name
    if getattr(meeting, "_human_name", None):
        result[sanitize_name(meeting._human_name)] = meeting._human_name
    result["System"] = "System"
    return result


@app.get("/meetings/{meeting_id}/history", response_model=List[dict])
def get_history(meeting_id: str):
    meeting = STORE.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(404, detail="Meeting not found")

    display_map = _build_name_display_map(meeting)
    history = []
    turn_counter = 0
    for msg in meeting.history:
        sanitized = getattr(msg, "name", "") or ""
        if sanitized == "MeetingGoal":
            continue

        extras = getattr(msg, "additional_kwargs", {}) or {}
        route_plan = extras.get("route_plan")
        steps_log = extras.get("steps_log")
        steps_label = extras.get("steps_label")
        max_steps = extras.get("max_steps")
        score = extras.get("score")
        public_text = extras.get("public_text")

        # Check if this is a phase message (System message without route_plan and without turn in extras)
        is_phase_message = (sanitized == "System" and not route_plan and "turn" not in extras)

        # Only increment turn counter for actual messages (not phase messages)
        if not is_phase_message:
            turn_counter += 1

        # Use turn from extras if available, otherwise use turn_counter for non-phase messages
        turn_value = extras.get("turn", turn_counter if not is_phase_message else None)

        display_name = display_map.get(sanitized, sanitized)
        entry = {
            "name": display_name,
            "content": public_text if isinstance(public_text, str) else msg.content,
        }
        if turn_value is not None:
            entry["turn"] = turn_value
        if route_plan:
            entry["route_plan"] = route_plan
        if steps_log:
            entry["steps_log"] = steps_log
        if steps_label:
            entry["steps_label"] = steps_label
        if max_steps is not None:
            entry["max_steps"] = max_steps
        if score is not None:
            entry["score"] = score
        history.append(entry)
    return history


class HumanRouteDraftRequest(BaseModel):
    description: str = ""
    route: List[Dict[str, Any]] = Field(default_factory=list)
    model_name: Optional[str] = None
    # The refine dialog's prior chat, oldest first: {"role": "user"|"ai", "content": str}
    history: List[Dict[str, str]] = Field(default_factory=list)


@app.post("/meetings/{meeting_id}/human_route_draft")
async def human_route_draft(meeting_id: str, req: HumanRouteDraftRequest = Body(...)):
    """Generate/complete a route from the human's description via an LLM.

    The draft runs on generate_with_ai.draft_route_for_human's neutral assistant
    prompt — never as one of the meeting's participants; they only supply LLM
    configs. Defaults to the first participant's model; when `model_name` is
    given, reuse the LLM of a participant already on that model, else build
    one with load_llm.
    """
    meeting = STORE.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(404, detail="Meeting not found")
    participants = getattr(meeting, "participants", [])
    if not participants:
        raise HTTPException(400, detail="Add at least one LLM participant to use route generation.")

    llm = participants[0].llm
    if req.model_name:
        info = STORE.get_meeting_info(meeting_id)
        matching_engine_name = None
        for cfg in (info.get("participants_config", []) if info else []):
            if cfg.get("model_name") == req.model_name:
                matching_engine_name = cfg.get("engine_name")
                break
        matched_participant = None
        if matching_engine_name:
            matched_participant = next(
                (p for p in participants if p.name == matching_engine_name), None
            )
        if matched_participant is not None:
            llm = matched_participant.llm
        else:
            try:
                llm = load_llm(
                    model_name=req.model_name,
                    temperature=(1.0 if req.model_name.startswith("openai/gpt-5") else 0.7),
                    seed=42,
                    max_tokens=None,
                    max_context_length=None,
                )
            except Exception as exc:  # noqa: BLE001 — surface a clear 400 to the UI
                raise HTTPException(
                    400, detail=f"Unknown or unavailable model: {req.model_name}"
                ) from exc

    first = participants[0]
    try:
        draft = await draft_route_for_human(
            llm=llm,
            description=req.description,
            meeting_goal=getattr(meeting, "_global_goals", None) or getattr(meeting, "global_goals", None),
            current_route_text="",
            partial_route=req.route,
            meeting_title=getattr(first, "meeting_title", "") or "",
            constraints_text=getattr(first, "constraints_text", "") or "",
            history=req.history,
        )
    except Exception as exc:  # noqa: BLE001 — surface generation failure to the UI
        logger.exception("Human route draft failed for meeting %s", meeting_id)
        raise HTTPException(502, detail=f"Route generation failed: {type(exc).__name__}: {exc}")

    destinations = [d.model_dump() for d in draft.route]
    return {"message": draft.message, "route": destinations}


@app.get("/meetings/{meeting_id}/analytics/summary")
def get_analytics_summary(meeting_id: str):
    """
    Get a comprehensive summary of analytics metrics for the meeting.

    Returns discussion dynamics (activity, proposals, consensus) and
    route characteristics (travel time, cost, destinations).
    """
    meeting = STORE.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(404, detail="Meeting not found")

    return meeting.get_analytics_summary()


@app.get("/meetings/{meeting_id}/analytics/export")
def export_analytics(meeting_id: str):
    """
    Export all raw analytics data for the meeting.

    Returns complete analytics data including:
    - Discussion dynamics (activity metrics, proposal history, consensus data)
    - Route characteristics (all route snapshots, transitions)
    - Meeting metadata (timestamps, duration)

    This data can be used for external analysis, visualization, or research.
    """
    meeting = STORE.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(404, detail="Meeting not found")

    return meeting.export_analytics()


@app.get("/settings/api-keys")
def get_api_keys():
    payload = {}
    for provider in API_PROVIDERS:
        env_key_name = get_env_key_name(provider)
        key = os.environ.get(env_key_name, "")
        configured = False
        masked = None
        if key and verify_api_key(provider, key):
            configured = True
            masked = mask_key(key)
        payload[provider] = {
            "configured": configured,
            "masked_key": masked,
        }
    return payload


@app.post("/settings/api-keys")
def update_api_key(body: ApiKeyUpdate):
    provider = body.provider.lower()
    if provider not in API_PROVIDERS:
        raise HTTPException(400, detail="Unsupported provider")

    api_key = body.api_key.strip()
    if not api_key:
        raise HTTPException(400, detail="API key must not be empty")

    if not verify_api_key(provider, api_key):
        raise HTTPException(400, detail="Invalid API key")

    env_key_name = get_env_key_name(provider)
    os.environ[env_key_name] = api_key

    if provider == "openai":
        openai.api_key = api_key

    return {
        "ok": True,
        "provider": provider,
        "masked_key": mask_key(api_key),
    }

@app.post("/meetings/generate-random-sample", response_model=RandomSampleResponse)
def generate_random_sample(payload: Optional[RandomSampleRequest] = Body(default=None)):
    """Generate a random meeting settings sample using LLM"""
    # Get available API key
    api_key = None
    model_name = None

    # Try OpenAI first
    if os.getenv("OPENAI_API_KEY"):
        api_key = os.getenv("OPENAI_API_KEY")
        model_name = "openai/gpt-4o-mini"
    # Then try Anthropic
    elif os.getenv("ANTHROPIC_API_KEY"):
        api_key = os.getenv("ANTHROPIC_API_KEY")
        model_name = "anthropic/claude-3-5-sonnet-20241022"
    # Then try Google
    elif os.getenv("GOOGLE_API_KEY"):
        api_key = os.getenv("GOOGLE_API_KEY")
        model_name = "google/gemini-2.0-flash-exp"
    else:
        raise HTTPException(400, detail="No LLM API key configured. Please configure an API key in settings.")

    try:
        # Load LLM
        llm = load_llm(model_name=model_name, temperature=1.0, seed=None)

        # Create prompt for generating random meeting settings
        payload = payload or RandomSampleRequest()
        provided = payload.model_dump(exclude_none=True)
        prompt = """Generate a random tour meeting scenario with realistic settings. Create a diverse and interesting meeting setup.

Requirements:
1. Create 2-4 participants with diverse personalities and preferences
2. Each participant should have:
   - A name (can be from any culture)
   - A background (relevant context, experience, or situation)
   - A personality (stable traits, e.g. cautious, curious, analytical, sociable)
   - Preferences (likes, dislikes, priorities, and constraints)
   - Personal goals for the tour
   - One facilitator and the rest as attendees
3. Create a compelling meeting title
4. Define a clear global goal for planning a ONE-DAY tour in any city around the world
   - The tour must be planned within a single day
   - Include the city name in the global goal
5. Set realistic constraints:
   - Travel date (YYYY-MM-DD format)
   - Budget (in any currency format, e.g., "$500", "€400", "¥50000")
   - Time window (HH:MM format, e.g., "09:00" to "18:00") - must be within a single day
   - Max turns (10-30)
6. Choose meeting workflow settings:
   - include_human: boolean
   - initialization_turn_rule: one of ["round_robin", "inviting", "facilitating", "random"]
   - initialization_voting_rule: one of ["majority", "unanimous", "most_pleasure", "least_misery", "single_decider"]
   - volunteer_mode: boolean
   - balanced_turns: boolean
   - vote_turn_rule: one of ["round_robin", "inviting", "facilitating", "random"]
   - vote_settings_linked: boolean

Generate varied and creative scenarios. Make each participant's preferences distinct and sometimes conflicting to create interesting dynamics.

If a field is provided below, copy it exactly and do not randomize it.
Provided fields (JSON): __PROVIDED_FIELDS_JSON__

Respond with a JSON object with the following structure:
{
  "title": "Meeting title",
  "participants": [
    {
      "model_name": "openai/gpt-5.4-mini",
      "temperature": 1,
      "seed": 42,
      "name": "Participant name",
      "background": "Relevant context, experience, or situation",
      "personality": "Stable traits, e.g. cautious, curious, analytical, sociable",
      "preferences": "Likes, dislikes, priorities, and constraints",
      "personal_goals": "Specific goals for the tour",
      "role": "facilitator" or "attendee",
      "speaking_style": "friendly",
      "explanation_style": "auto",
      "web_search": true
    }
  ],
  "global_goal": "Meeting objective",
  "include_human": false,
  "travel_date": "YYYY-MM-DD",
  "budget": "Currency amount (e.g., $500, €400, ¥50000)",
  "time_window_start": "HH:MM",
  "time_window_end": "HH:MM",
  "max_turns": 20,
  "time_limit": null,
  "initialization_turn_rule": "round_robin",
  "initialization_voting_rule": "majority",
  "volunteer_mode": false,
  "balanced_turns": true,
  "vote_turn_rule": "round_robin",
  "vote_settings_linked": true
}"""
        prompt = prompt.replace(
            "__PROVIDED_FIELDS_JSON__",
            json.dumps(provided, ensure_ascii=False),
        )

        # Invoke LLM via litellm
        import litellm as _litellm
        from ..llm import build_litellm_kwargs, extract_json as _extract_json
        _llm_kwargs = build_litellm_kwargs(llm)
        _resp = _litellm.completion(
            messages=[{"role": "user", "content": prompt}],
            **_llm_kwargs,
        )
        content = _resp.choices[0].message.content or ""

        # Parse JSON response
        data = _extract_json(content)

        # Respect provided fields: only unspecified values should be randomized.
        merged = dict(data) if isinstance(data, dict) else {}
        for key, value in provided.items():
            merged[key] = value

        # Fixed policy for random sample defaults.
        merged["include_human"] = False
        merged["max_turns"] = 100
        merged["budget"] = "$100"

        if merged.get("initialization_turn_rule") not in TURN_RULE_OPTIONS:
            merged["initialization_turn_rule"] = "round_robin"
        if merged.get("vote_turn_rule") not in VOTE_TURN_RULE_OPTIONS:
            merged["vote_turn_rule"] = "round_robin"
        if merged.get("initialization_voting_rule") not in VOTING_RULE_OPTIONS:
            merged["initialization_voting_rule"] = "majority"
        if not isinstance(merged.get("volunteer_mode"), bool):
            merged["volunteer_mode"] = False
        if not isinstance(merged.get("balanced_turns"), bool):
            merged["balanced_turns"] = True
        if not isinstance(merged.get("vote_settings_linked"), bool):
            merged["vote_settings_linked"] = True
        if not isinstance(merged.get("include_human"), bool):
            merged["include_human"] = False

        # Validate and return
        return RandomSampleResponse(**merged)

    except Exception as e:
        logger.error(f"Failed to generate random sample: {e}")
        raise HTTPException(500, detail=f"Failed to generate random sample: {str(e)}")

@app.get("/meetings/{meeting_id}/order", response_model=List[str])
def get_order(meeting_id: str):
    info = STORE.get_meeting_info(meeting_id)
    if not info:
        raise HTTPException(404, detail="Meeting not found")
    return info.get("order", [])

@app.patch("/meetings/{meeting_id}/order")
def patch_order(meeting_id: str, body: OrderUpdate):
    info = STORE.get_meeting_info(meeting_id)
    if not info:
        raise HTTPException(404, detail="Meeting not found")

    # 検証：存在する参加者id＋ "__YOU__" のみ
    configs = info.get("participants_config", [])
    valid_ids = {cfg.get("id") for cfg in configs if cfg.get("id")}
    new_order = []
    for x in body.order:
        if x == "__YOU__":
            if info.get("include_human", False):
                new_order.append(x)
        elif x in valid_ids and x not in new_order:
            new_order.append(x)
    # 欠けている参加者（順序から漏れた分）は最後に足す（安全策）
    for cfg in configs:
        if cfg.get("id") and cfg["id"] not in new_order:
            new_order.append(cfg["id"])
    # 人が有効なのに "__YOU__" がない場合は末尾に
    if info.get("include_human", False) and "__YOU__" not in new_order:
        new_order.append("__YOU__")

    info["order"] = new_order
    STORE.save()
    return {"ok": True, "order": new_order}


def _read_llm_mode() -> dict:
    """Read .llm-mode file written by Makefile at startup."""
    for candidate in (
        Path("/app/.llm-mode"),        # inside Docker container
        Path(__file__).resolve().parents[2] / ".llm-mode",  # project root
    ):
        if candidate.is_file():
            try:
                return json.loads(candidate.read_text())
            except Exception:
                pass
    return {}


def _probe_url(url: str, timeout: float = 3.0) -> Optional[dict]:
    """Probe a URL and return parsed JSON response, or None on failure."""
    import urllib.request
    import urllib.error
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode())
    except Exception:
        pass
    return None


@app.get("/settings/integrations")
def get_integrations():
    """Return which local LLM integrations are enabled (from .llm-mode)
    and their connectivity status (probed via Docker-internal URLs).
    """
    mode = _read_llm_mode()

    ollama_raw = mode.get("ollama", [])
    vllm_raw = mode.get("vllm", [])

    # Normalize ollama config: old string format -> new array format
    if isinstance(ollama_raw, str):
        if ollama_raw in ("cpu", "gpu"):
            ollama_instances = [{"mode": ollama_raw, "gpus": []}]
        else:
            ollama_instances = []
    elif isinstance(ollama_raw, list):
        ollama_instances = ollama_raw
    else:
        ollama_instances = []

    # Probe each Ollama instance
    ollama_results = []
    for idx, inst in enumerate(ollama_instances):
        env_key = f"OLLAMA_BASE_{idx}"
        ollama_base = os.getenv(env_key) or os.getenv("OLLAMA_BASE", "")

        connected = False
        if ollama_base:
            connected = _probe_url(f"{ollama_base}/api/tags") is not None

        ollama_results.append({
            "index": idx,
            "mode": inst.get("mode", "gpu"),
            "gpus": inst.get("gpus", []),
            "connected": connected,
        })

    # Normalize vllm config: old string format -> new array format
    if isinstance(vllm_raw, str):
        vllm_instances = [{"model": vllm_raw, "gpus": [0]}] if vllm_raw else []
    elif isinstance(vllm_raw, list):
        vllm_instances = vllm_raw
    else:
        vllm_instances = []

    # Probe each vLLM instance
    vllm_results = []
    for idx, inst in enumerate(vllm_instances):
        model_cfg = inst.get("model", "")
        gpus = inst.get("gpus", [])

        env_key = f"VLLM_BASE_{idx}"
        vllm_base = os.getenv(env_key) or os.getenv("VLLM_BASE", "")

        connected = False
        serving = None
        if vllm_base:
            data = _probe_url(f"{vllm_base}/models")
            if data:
                connected = True
                models_data = data.get("data", [])
                if models_data:
                    serving = models_data[0].get("id")

        vllm_results.append({
            "index": idx,
            "enabled": True,
            "model": model_cfg,
            "gpus": gpus,
            "connected": connected,
            "serving": serving,
            "max_model_len": inst.get("max_model_len"),
        })

    return {
        "ollama": ollama_results,
        "vllm": vllm_results,
    }


@app.delete("/settings/cache")
def delete_cache():
    """Clear the litellm disk cache."""
    cleared = clear_llm_cache()
    return {"ok": True, "cleared": cleared}


@app.get("/models/info")
def get_model_info(model: str):
    """Return max input/output token metadata for a commercial model via litellm."""
    info = get_commercial_model_info(model)
    if info is None:
        raise HTTPException(404, detail=f"Model info not found for {model}")
    return info


@app.get("/ollama/models")
def get_ollama_models():
    """Get list of available Ollama models (shared cache, query instance 0)"""
    base_url = os.getenv("OLLAMA_BASE_0") or os.getenv("OLLAMA_BASE")
    models = list_ollama_models(base_url)
    return {"models": models}


@app.post("/ollama/pull")
async def pull_model(body: dict):
    """Pull an Ollama model (shared cache, pull via instance 0)"""
    model_name = body.get("model_name")
    if not model_name:
        raise HTTPException(400, detail="model_name is required")

    base_url = os.getenv("OLLAMA_BASE_0") or os.getenv("OLLAMA_BASE")

    async def generate():
        for progress in pull_ollama_model(model_name, base_url):
            yield json.dumps(progress) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.websocket("/ws/meeting/{meeting_id}")
async def ws_meeting(ws: WebSocket, meeting_id: str):
    info = STORE.get_meeting_info(meeting_id)
    if not info:
        await ws.close(code=1008, reason="Meeting not found")
        return

    await ws.accept()

    queue: Optional[asyncio.Queue] = None
    forward_task: Optional[asyncio.Task] = None

    async def forward_events(event_queue: asyncio.Queue) -> None:
        try:
            while True:
                event = await event_queue.get()
                if event is None:
                    break
                if isinstance(event, dict) and event.get("type") == "close":
                    break
                try:
                    await ws.send_json(event)
                except Exception:
                    # WebSocket is closed or in error state, stop forwarding
                    break
        except WebSocketDisconnect:
            pass
        except asyncio.CancelledError:
            # Task was cancelled, this is expected during cleanup
            pass
        except Exception:
            # Ignore other errors
            pass

    try:
        while True:
            raw = await ws.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "message": "invalid json"})
                continue

            cmd = payload.get("cmd")
            if cmd == "start":
                max_turns_value = payload.get("max_turns", info.get("max_turns", 100))
                try:
                    max_turns = int(max_turns_value)
                except (TypeError, ValueError):
                    max_turns = info.get("max_turns", 100)
                if max_turns <= 0:
                    max_turns = info.get("max_turns", 100)

                time_limit_value = payload.get("time_limit")
                try:
                    time_limit = (
                        int(time_limit_value)
                        if time_limit_value is not None
                        else None
                    )
                except (TypeError, ValueError):
                    time_limit = None
                if time_limit is not None and time_limit <= 0:
                    time_limit = None

                try:
                    (
                        new_queue,
                        backlog,
                        status,
                        reason,
                        elapsed,
                    ) = STORE.start_meeting_stream(
                        meeting_id,
                        payload.get("goal"),
                        max_turns,
                        time_limit,
                    )
                except KeyError:
                    await ws.send_json(
                        {"type": "error", "message": "Meeting not found"}
                    )
                    continue

                if forward_task:
                    forward_task.cancel()
                    with suppress(Exception):
                        await forward_task

                queue = new_queue
                forward_task = asyncio.create_task(forward_events(queue))

                await ws.send_json(
                    {
                        "type": "status",
                        "meeting_id": meeting_id,
                        "status": status,
                        "reason": reason,
                        "elapsed": elapsed,
                    }
                )
                for item in backlog:
                    await ws.send_json({**item, "replay": True})

            elif cmd == "watch":
                (
                    new_queue,
                    backlog,
                    status,
                    reason,
                    elapsed,
                ) = STORE.subscribe_meeting_stream(
                    meeting_id
                )
                await ws.send_json(
                    {
                        "type": "status",
                        "meeting_id": meeting_id,
                        "status": status,
                        "reason": reason,
                        "elapsed": elapsed,
                    }
                )
                if new_queue is not None:
                    if forward_task:
                        forward_task.cancel()
                        with suppress(Exception):
                            await forward_task
                    queue = new_queue
                    forward_task = asyncio.create_task(forward_events(queue))
                    for item in backlog:
                        await ws.send_json({**item, "replay": True})

            elif cmd == "message":
                STORE.submit_human_input(meeting_id, payload.get("message", ""))

            elif cmd == "vote":
                STORE.submit_human_vote(meeting_id, payload.get("vote_data", {}))

            elif cmd == "select_speaker":
                STORE.submit_human_selection(meeting_id, payload.get("speaker", ""))

            elif cmd == "ask_answer":
                STORE.submit_human_ask_answer(meeting_id, payload.get("answer", ""))

            elif cmd == "stop":
                STORE.stop_meeting_runtime(meeting_id)

            else:
                await ws.send_json({"type": "error", "message": "unknown cmd"})

    except WebSocketDisconnect:
        pass
    finally:
        if forward_task:
            forward_task.cancel()
            with suppress(Exception):
                await forward_task
        STORE.unsubscribe_meeting_stream(meeting_id, queue)
        with suppress(Exception):
            await ws.close()

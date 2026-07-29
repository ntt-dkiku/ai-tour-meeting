import time
import asyncio
import random
import logging
from contextlib import suppress
import inspect
from typing import Any, Dict, List, Literal, Optional, Tuple, Union, AsyncIterator, TYPE_CHECKING

if TYPE_CHECKING:
    from .integration import ExternalSystem
from .messages import HumanMessage, AIMessage

from .participant import (
    Participant,
    RouteDraft,
    Destination,
    is_authentication_error,
)
from .types import (
    MeetingEvent,
    MeetingStarted,
    TurnStart,
    Delta,
    TurnFinal,
    HumanTurn,
    HumanVote,
    HumanSelectSpeaker,
    HumanAsk,
    PhaseMessage,
    RoutePlanUpdate,
    Timeout,
    MeetingFinished,
    RetryNotification,
    AskPending,
    AskExchange,
    ProposalVoteResult,
    SatisfiedUpdate,
    RoundEnd,
    DeadlockIntervention,
    AdviceInjected,
)
from .deadlock import DeadlockDetector, DEFAULT_SIGNALS as DEADLOCK_DEFAULT_SIGNALS
from .analytics import MeetingAnalytics
from .utils import format_event, format_cost_totals, parse_cost_amount
from .turn_selector import create_selector, FacilitatingSelector, PhaseCallback

import re

logger = logging.getLogger(__name__)

def _ordinal(n: int) -> str:
    """Return ordinal string: 1->'1st', 2->'2nd', 3->'3rd', 4->'4th', etc."""
    if 11 <= (n % 100) <= 13:
        return f"{n}th"
    return f"{n}{['th','st','nd','rd'][n % 10] if n % 10 < 4 else 'th'}"

def sanitize_name(s: str) -> str:
    s = re.sub(r'[\s\u3000<|\\/>\n\r\t]+', '_', s or '')
    s = s.strip('_') or 'anon'
    return s[:64]

def build_constraints_text(constraints: Dict[str, Any]) -> str:
    """Build a constraints prompt string from a dict of constraint fields.

    Recognized keys: travel_date, time_window_start, time_window_end, budget.
    Unknown keys are formatted as "Key: value".
    Returns empty string if no constraints are present.
    """
    parts: List[str] = []
    if constraints.get("travel_date"):
        parts.append(f"Travel Date: {constraints['travel_date']}")
    tw_start = constraints.get("time_window_start")
    tw_end = constraints.get("time_window_end")
    if tw_start and tw_end:
        parts.append(f"Time Window: {tw_start} - {tw_end}")
    elif tw_start:
        parts.append(f"Start Time: {tw_start}")
    elif tw_end:
        parts.append(f"End Time: {tw_end}")
    if constraints.get("budget"):
        parts.append(f"Budget per participant: {constraints['budget']}")
    # Handle any extra keys not explicitly handled above
    known_keys = {"travel_date", "time_window_start", "time_window_end", "budget"}
    for key, value in constraints.items():
        if key not in known_keys and value:
            label = key.replace("_", " ").title()
            parts.append(f"{label}: {value}")
    if not parts:
        return ""
    return "- Constraints:\n" + "\n".join(f"  - {p}" for p in parts)

_TURN_RULE_DESCRIPTIONS: Dict[str, str] = {
    "round_robin": "speakers take turns in a fixed, rotating order",
    "random": "the speaking order is randomized; when balanced turns are off, speakers may repeat before everyone has spoken",
    "inviting": "after finishing their turn, each speaker chooses who speaks next",
    "facilitating": "a designated facilitator chooses who speaks next after every turn",
    "parallel": "all eligible voters cast their votes simultaneously and independently, without seeing others' votes first",
}

_VOTING_RULE_DESCRIPTIONS: Dict[str, str] = {
    "majority": "a proposed route is adopted once it wins a strict majority of votes",
    "unanimous": "a proposed route is adopted only when every participant accepts it",
    "most_pleasure": "a proposed route is adopted when it maximizes the total satisfaction score across participants",
    "least_misery": "a proposed route is adopted when it maximizes the lowest satisfaction score among participants",
    "single_decider": "a single designated decider's accept/reject vote determines whether a proposed route is adopted",
}

_BALANCED_TURNS_DESCRIPTIONS: Dict[bool, str] = {
    True: "every participant must speak once before anyone speaks a second time in the same round",
    False: "participants may speak freely, with no requirement to take turns evenly within a round",
}

_VOLUNTEER_MODE_DESCRIPTIONS: Dict[bool, str] = {
    True: "participants may pass on their turn if they have nothing new to add",
    False: "participants must contribute something on every turn (passing is not allowed)",
}

def build_meeting_workflow_text(
    turn_rule: str,
    voting_rule: str,
    vote_turn_rule: str,
    balanced_turns: bool,
    volunteer_mode: bool,
    single_decider: Optional[str] = None,
) -> str:
    """Build a short, structured participant-facing description of the
    meeting's turn-taking, voting, and participation mechanics, based on the
    resolved workflow settings."""
    _no_desc = "no built-in description available for this custom setting"
    turn_desc = _TURN_RULE_DESCRIPTIONS.get(turn_rule, _no_desc)
    vote_desc = _VOTING_RULE_DESCRIPTIONS.get(voting_rule, _no_desc)
    if voting_rule == "single_decider" and single_decider:
        vote_desc = f"{vote_desc} (designated decider: {single_decider})"
    vote_turn_desc = _TURN_RULE_DESCRIPTIONS.get(vote_turn_rule, _no_desc)
    balanced_desc = _BALANCED_TURNS_DESCRIPTIONS[bool(balanced_turns)]
    if turn_rule == "random" and not balanced_turns:
        balanced_desc = "speakers may be chosen repeatedly at random within a round"
    volunteer_desc = _VOLUNTEER_MODE_DESCRIPTIONS[bool(volunteer_mode)]
    return (
        "- Meeting Workflow:\n"
        f"  - Speaking Turn ({turn_rule}): {turn_desc}\n"
        f"  - Voting Rule ({voting_rule}): {vote_desc}\n"
        f"  - Voting Turn ({vote_turn_rule}): {vote_turn_desc}\n"
        f"  - Balanced Option ({balanced_turns}): {balanced_desc}\n"
        f"  - Volunteer Option ({volunteer_mode}): {volunteer_desc}"
    )

class AITourMeeting:
    def __init__(
        self,
        title: Optional[str] = None,
        global_goals: Optional[str] = None,
        constraints: Optional[Union[str, Dict[str, Any]]] = None,
        settings: Optional[Dict[str, Any]] = None,
    ):
        self.participants: List[Participant] = []
        self.history = []
        self._stop = asyncio.Event()
        self._human_enabled = False
        self._human_name = "You"
        self._human_queue: Optional[asyncio.Queue[str]] = None
        self._human_vote_queue: Optional[asyncio.Queue[Dict[str, Any]]] = None
        self._human_select_queue: Optional[asyncio.Queue[str]] = None
        self._human_ask_queue: Optional[asyncio.Queue[str]] = None
        # Advisory messages queued by external systems (see inject_advice)
        self._advice_inbox: List[Tuple[str, str]] = []
        # External system seated among the participants (see add_external_system)
        self._external_system: Optional["ExternalSystem"] = None
        self._external_seat_index: Optional[int] = None
        self._order: List[str] = []
        # The last accepted itinerary (destination dicts); None until a
        # proposal is accepted.
        self.final_route: Optional[List[Dict[str, Any]]] = None
        self.analytics = MeetingAnalytics()
        # Pre-configured meeting parameters (used as defaults by run_free_conversation)
        self._title = title
        self._global_goals = global_goals
        self._constraints = constraints
        self._settings = settings or {}

    def add_participant(self, participant: Union[Participant, "ExternalSystem"]) -> None:
        from .integration import ExternalSystem
        if isinstance(participant, ExternalSystem):
            self.add_external_system(participant)
            return
        self.participants.append(participant)

    def add_participants(self, participants: List[Union[Participant, "ExternalSystem"]]) -> None:
        for participant in participants:
            self.add_participant(participant)

    def add_external_system(self, system: "ExternalSystem") -> None:
        """Seat an :class:`~tour_meeting.integration.ExternalSystem`.

        The seat's position in the speaking order matches where it was added:
        participants added before it speak earlier, ones added after speak
        later (override with :meth:`set_order`). Only one external system can
        take a seat; its callbacks are dispatched automatically when the
        meeting runs.
        """
        if self._external_system is not None and self._external_system is not system:
            raise ValueError("Only one external system can join a meeting.")
        self._external_system = system
        system.meeting = self
        if system.participate:
            self.enable_human(system.name)
            if self._external_seat_index is None:
                self._external_seat_index = len(self.participants)

    def reset(self):
        self.history = []
        self._stop = asyncio.Event()
        self._human_queue = asyncio.Queue() if self._human_enabled else None
        self._human_vote_queue = asyncio.Queue() if self._human_enabled else None
        self._human_select_queue = asyncio.Queue() if self._human_enabled else None
        self._human_ask_queue = asyncio.Queue() if self._human_enabled else None
        self.final_route = None
        self.analytics = MeetingAnalytics()
        for participant in self.participants:
            if hasattr(participant, "reset_context_cache"):
                participant.reset_context_cache()

    def enable_human(self, name: str = "You"):
        self._human_enabled = True
        self._human_name = name
        if self._human_queue is None:
            self._human_queue = asyncio.Queue()
        if self._human_vote_queue is None:
            self._human_vote_queue = asyncio.Queue()
        if self._human_select_queue is None:
            self._human_select_queue = asyncio.Queue()
        if self._human_ask_queue is None:
            self._human_ask_queue = asyncio.Queue()

    def set_order(self, order: List[str]):
        # "__YOU__" は1つまで
        seen_you = False
        normalized = []
        for x in order:
            if x == "__YOU__":
                if not self._human_enabled or seen_you:
                    continue
                seen_you = True
                normalized.append("__YOU__")
            else:
                normalized.append(x)
        self._order = normalized

    def _name_to_participant(self, name: str) -> Optional[Participant]:
        for p in self.participants:
            if p.name == name:
                return p
        return None

    def submit_human(self, payload):
        """Deliver the human's speaking-turn action to the run loop.

        ``payload`` is normally an action dict ({"action", "message", ...}); a
        bare string is accepted as a plain "speak" message for back-compat.
        """
        if not self._human_enabled or self._human_queue is None:
            raise RuntimeError("Human is not enabled for this meeting.")
        self._human_queue.put_nowait(payload)

    def submit_human_vote(self, vote_data: Dict[str, Any]):
        if not self._human_enabled or self._human_vote_queue is None:
            raise RuntimeError("Human is not enabled for this meeting.")
        self._human_vote_queue.put_nowait(vote_data)

    def submit_human_selection(self, speaker: str):
        """Deliver the human facilitator's next-speaker pick to the run loop."""
        if not self._human_enabled or self._human_select_queue is None:
            raise RuntimeError("Human is not enabled for this meeting.")
        self._human_select_queue.put_nowait(speaker)

    def submit_human_ask_answer(self, answer: str):
        """Deliver the human's answer to an LLM participant's question."""
        if not self._human_enabled or self._human_ask_queue is None:
            raise RuntimeError("Human is not enabled for this meeting.")
        self._human_ask_queue.put_nowait(answer)

    def inject_advice(self, message: str, source: str = "Advisor") -> None:
        """Queue an advisory message for the meeting.

        The message is appended to the shared history right before the next
        turn begins, so every participant sees it on their next turn — the
        same mechanism as the built-in deadlock mediation, but driven by
        external code (e.g., a recommender system under evaluation). Unlike
        the human-participant interface, this does not occupy a seat or a
        turn and can be called at any time while consuming the event stream.
        """
        text = (message or "").strip()
        if not text:
            return
        self._advice_inbox.append((text, (source or "Advisor").strip() or "Advisor"))

    def get_conversation_history(self) -> List[Dict[str, Any]]:
        """The conversation history so far.

        Returns a list of ``{"speaker", "text", "turn"}`` dicts in
        chronological order, including the participants' utterances and the
        system's phase notices. Also attached to human-facing events
        (``HumanTurn``, ``HumanVote``, ...) as ``event.conversation_history``.
        """
        entries: List[Dict[str, Any]] = []
        for msg in self.history:
            name = getattr(msg, "name", "") or ""
            content = getattr(msg, "content", "") or ""
            if not name or not content:
                continue
            extras = getattr(msg, "additional_kwargs", None) or {}
            entries.append({
                "speaker": name,
                "text": content,
                "turn": extras.get("turn"),
            })
        return entries

    def _is_human_ask_target(self, target_name: str) -> bool:
        """Whether an ``ask`` targets the human participant.

        The LLM is shown the human's display name (not the ``__YOU__`` sentinel),
        so a target may arrive as the display name, its sanitized form, or the
        sentinel itself.
        """
        if not self._human_enabled:
            return False
        if target_name == "__YOU__":
            return True
        human = self._human_name or ""
        return (
            target_name == human
            or target_name == sanitize_name(human)
            or target_name.replace("_", " ") == human
        )

    def _display_participant_names(self, names: List[str]) -> List[str]:
        """Map the ``__YOU__`` sentinel to the human's display name for the LLM."""
        return [self._human_name if n == "__YOU__" else n for n in names]

    async def _human_ask_roundtrip(
        self,
        out_queue: "asyncio.Queue[Dict[str, Any]]",
        turn: int,
        asker_name: str,
        question: str,
        start_time: float,
        time_limit: Optional[int],
    ) -> str:
        """Surface an LLM's question to the human and return their typed answer.

        Runs inside the asking participant's task; pushes UI events onto the
        turn's own queue (drained concurrently by the run loop) and blocks on the
        shared human-ask queue until an answer (or the time limit) arrives.
        """
        target = self._human_name
        await out_queue.put({
            "ask_pending": {"turn": turn, "asker": asker_name, "target": target, "question": question}
        })
        await out_queue.put({
            "human_ask": {"turn": turn, "asker": asker_name, "target": target, "question": question}
        })
        if self._human_ask_queue is None:
            self._human_ask_queue = asyncio.Queue()
        remaining: Optional[float] = None
        if time_limit is not None:
            remaining = max(0.0, time_limit - (time.monotonic() - start_time))
        try:
            answer = await (
                asyncio.wait_for(self._human_ask_queue.get(), timeout=remaining)
                if remaining is not None
                else self._human_ask_queue.get()
            )
        except asyncio.TimeoutError:
            answer = ""
        answer = (answer or "").strip()
        # stop() unblocks this wait with an empty sentinel: abort the asker's
        # turn (the drain loop cancels it) instead of feeding a fabricated
        # "(No response.)" back to the LLM and letting the meeting continue.
        if self._stop.is_set() and not answer:
            await out_queue.put({"stop_abort": True})
            return ""
        await out_queue.put({
            "ask_exchange": {
                "turn": turn, "asker": asker_name, "target": target,
                "question": question, "response": answer,
            }
        })
        return answer or "(No response.)"

    def stop(self):
        self._stop.set()
        # ★ 人の待機を解除したい場合は空文字などを入れてもよい
        if self._human_queue is not None and self._human_queue.empty():
            try:
                self._human_queue.put_nowait("")
            except Exception:
                pass
        # Unblock a human waiting to cast a vote on a proposal.
        if self._human_vote_queue is not None and self._human_vote_queue.empty():
            try:
                self._human_vote_queue.put_nowait({})
            except Exception:
                pass
        # Unblock a human facilitator waiting to pick the next speaker.
        if self._human_select_queue is not None and self._human_select_queue.empty():
            try:
                self._human_select_queue.put_nowait("")
            except Exception:
                pass
        # Unblock a human being asked a question by an LLM participant.
        if self._human_ask_queue is not None and self._human_ask_queue.empty():
            try:
                self._human_ask_queue.put_nowait("")
            except Exception:
                pass

    def _drain_human_queues(self) -> None:
        """Discard leftover items (e.g. stop() sentinels) before a new run.

        stop() pushes unblock sentinels even when no wait is active; without a
        drain, a resumed run would instantly consume them as real input.
        """
        for q in (
            self._human_queue,
            self._human_vote_queue,
            self._human_select_queue,
            self._human_ask_queue,
        ):
            if q is None:
                continue
            while not q.empty():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    break

    @staticmethod
    def _chunk_text(text: str, chunk_size: int = 120) -> List[str]:
        if not text:
            return []
        return [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)]
    
    @staticmethod
    def _extract_internal_metadata(chunk: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not isinstance(chunk, dict):
            return None
        internal_event = chunk.get("internal_event")
        if internal_event:
            return {"internal_event": internal_event}
        return None
    
    @staticmethod
    def _format_turn_error(action: str, exc: Exception) -> str:
        return f"[error] Unable to {action}: {type(exc).__name__}: {exc}"
    
    @staticmethod
    def _build_additional_kwargs(turn: int, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payload = dict(extra or {})
        payload["turn"] = turn
        return payload

    @staticmethod
    def _analytics_vote_score(
        voting_rule: str,
        vote_obj: Dict[str, Any],
    ) -> Optional[float]:
        """Convert vote payload to analytics score by voting rule.

        - majority/single_decider: approval voting (no score)
        - unanimous: approval voting (no score)
        - most_pleasure/least_misery: score-based voting
        """
        if voting_rule in {"majority", "unanimous", "single_decider"}:
            return None

        # Prefer explicit scalar score if available.
        raw_score = vote_obj.get("score")
        if isinstance(raw_score, (int, float)):
            return float(raw_score)
        if isinstance(raw_score, str):
            try:
                return float(raw_score)
            except ValueError:
                pass

        # Or derive from a scores list entry for route_id=1.
        entries = vote_obj.get("scores")
        if isinstance(entries, list):
            route_scores: List[float] = []
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                try:
                    rid = int(entry.get("route_id"))
                except (TypeError, ValueError):
                    continue
                if rid != 1:
                    continue
                try:
                    route_scores.append(float(entry.get("score")))
                except (TypeError, ValueError):
                    continue
            if route_scores:
                return sum(route_scores) / len(route_scores)

        # Last fallback for score-based modes.
        return 1.0 if bool(vote_obj.get("accept")) else 0.0

    @staticmethod
    def _is_majority_accepted(
        vote_records: List[Dict[str, Any]],
        include_proposer_implicit_accept: bool = False,
    ) -> bool:
        """Return True when accept votes are a strict majority.

        When ``include_proposer_implicit_accept`` is True, one additional
        implicit accept vote is added only for decision-making.
        """
        accept_count = sum(1 for v in vote_records if v.get("accept"))
        total_votes = len(vote_records)
        if include_proposer_implicit_accept:
            accept_count += 1
            total_votes += 1
        return accept_count > (total_votes / 2)

    @staticmethod
    def _is_unanimous_accepted(
        vote_records: List[Dict[str, Any]],
        include_proposer_implicit_accept: bool = False,
    ) -> bool:
        """Return True only when all considered votes are accepts."""
        if any(not bool(v.get("accept")) for v in vote_records):
            return False
        if include_proposer_implicit_accept:
            return True
        # If proposer is not counted and there are no voters, treat as not accepted.
        return len(vote_records) > 0

    @staticmethod
    def _route_representative_score(
        vote_records: List[Dict[str, Any]],
        *,
        mode: str,
    ) -> Optional[float]:
        """Compute representative score for route_id=1 from vote records.

        mode="sum"  -> sum of voter scores (most_pleasure)
        mode="min"  -> minimum voter score (least_misery)
        """
        scores: List[float] = []
        for vote in vote_records:
            scalar = vote.get("score")
            if isinstance(scalar, (int, float)):
                scores.append(float(scalar))
                continue
            if isinstance(scalar, str):
                try:
                    scores.append(float(scalar))
                    continue
                except ValueError:
                    pass

            entries = vote.get("scores")
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                try:
                    rid = int(entry.get("route_id"))
                except (TypeError, ValueError):
                    continue
                if rid != 1:
                    continue
                try:
                    scores.append(float(entry.get("score")))
                    break
                except (TypeError, ValueError):
                    continue

        if not scores:
            return None
        if mode == "sum":
            return float(sum(scores))
        return float(min(scores))

    async def run_free_conversation(
        self,
        global_goals: Optional[str] = None,
        turn_rule: Optional[str] = None,
        voting_rule: Optional[str] = None,
        resume_from_history: bool = False,
        max_turns: Optional[int] = None,
        time_limit: Optional[int] = None,
        volunteer_mode: Optional[bool] = None,
        balanced_turns: Optional[bool] = None,
        vote_turn_rule: Optional[str] = None,
        single_decider: Optional[str] = None,
        human_role: Optional[str] = None,
        title: Optional[str] = None,
        constraints: Optional[Union[str, Dict[str, Any]]] = None,
    ) -> AsyncIterator[MeetingEvent]:
        """Run a free conversation meeting where agents discuss, ask each other questions,
        search the web, and propose routes when ready.

        Parameters can be passed directly or pre-configured via the constructor.
        Direct arguments take priority over constructor settings.

        Each agent's turn:
        1. Internal actions (any combination): web search, ask another participant, reflection
        2. Conclusion (exactly one): proposal (triggers voting), discussion, or satisfied

        Termination: After a full round, if ALL participants chose satisfied AND at least
        one proposal was accepted → meeting ends.

        When an :class:`~tour_meeting.integration.ExternalSystem` is among the
        participants, its turns/votes are dispatched to its ``on_*`` callbacks
        automatically — no special handling needed by the consumer.

        Args:
            constraints: Either a pre-formatted string or a dict with keys like
                travel_date, time_window_start, time_window_end, budget.
        """
        stream = self._run_free_conversation(
            global_goals=global_goals,
            turn_rule=turn_rule,
            voting_rule=voting_rule,
            resume_from_history=resume_from_history,
            max_turns=max_turns,
            time_limit=time_limit,
            volunteer_mode=volunteer_mode,
            balanced_turns=balanced_turns,
            vote_turn_rule=vote_turn_rule,
            single_decider=single_decider,
            human_role=human_role,
            title=title,
            constraints=constraints,
        )
        system = self._external_system
        if system is None:
            async for event in stream:
                yield event
            return

        # Seat the external system in the speaking order at its seat position
        # (an explicit set_order() beforehand takes priority).
        if system.participate and "__YOU__" not in (self._order or []):
            if self._order:
                self.set_order(self._order + ["__YOU__"])
            else:
                names = [p.name for p in self.participants]
                idx = self._external_seat_index
                idx = len(names) if idx is None else min(idx, len(names))
                self.set_order(names[:idx] + ["__YOU__"] + names[idx:])

        async def _call(callback, event):
            result = callback(event)
            if inspect.isawaitable(result):
                result = await result
            # Typed actions (pydantic models, e.g. Propose / Vote) are
            # converted to the engine's payload dicts.
            if hasattr(result, "model_dump"):
                result = result.model_dump(exclude_none=True)
            return result

        async for event in stream:
            yield event
            await _call(system.on_event, event)
            if not system.participate:
                continue
            if isinstance(event, HumanTurn):
                payload = await _call(system.on_turn, event)
                if payload is not None:
                    self.submit_human(payload)
            elif isinstance(event, HumanVote):
                payload = await _call(system.on_vote, event)
                if payload is not None:
                    self.submit_human_vote(payload)
            elif isinstance(event, HumanAsk):
                answer = await _call(system.on_ask, event)
                self.submit_human_ask_answer(answer or "")
            elif isinstance(event, HumanSelectSpeaker):
                picked = await _call(system.on_select_speaker, event)
                self.submit_human_selection(picked or "")

    async def _run_free_conversation(
        self,
        global_goals: Optional[str] = None,
        turn_rule: Optional[str] = None,
        voting_rule: Optional[str] = None,
        resume_from_history: bool = False,
        max_turns: Optional[int] = None,
        time_limit: Optional[int] = None,
        volunteer_mode: Optional[bool] = None,
        balanced_turns: Optional[bool] = None,
        vote_turn_rule: Optional[str] = None,
        single_decider: Optional[str] = None,
        human_role: Optional[str] = None,
        title: Optional[str] = None,
        constraints: Optional[Union[str, Dict[str, Any]]] = None,
    ) -> AsyncIterator[MeetingEvent]:
        """Core event-stream generator behind :meth:`run_free_conversation`."""
        if not self.participants:
            raise RuntimeError("No participants have been added.")

        # Resolve parameters: direct args > constructor settings > defaults
        s = self._settings
        title = title if title is not None else self._title
        global_goals = global_goals if global_goals is not None else self._global_goals
        constraints = constraints if constraints is not None else self._constraints
        turn_rule = turn_rule if turn_rule is not None else s.get("turn_rule", "round_robin")
        voting_rule = voting_rule if voting_rule is not None else s.get("voting_rule", "majority")
        vote_turn_rule = vote_turn_rule if vote_turn_rule is not None else s.get("vote_turn_rule", "round_robin")
        single_decider = single_decider if single_decider is not None else s.get("single_decider")
        human_role = human_role if human_role is not None else s.get("human_role", "attendee")
        # The human acts as facilitator only when enabled and assigned the role.
        human_facilitator_key = (
            "__YOU__"
            if self._human_enabled and str(human_role or "").lower() == "facilitator"
            else None
        )
        max_turns = max_turns if max_turns is not None else s.get("max_turns")
        time_limit = time_limit if time_limit is not None else s.get("time_limit")
        volunteer_mode = volunteer_mode if volunteer_mode is not None else s.get("volunteer_mode", False)
        balanced_turns = balanced_turns if balanced_turns is not None else s.get("balanced_turns", True)

        # Deadlock detection: enabled by default, watching all signals; the
        # signal combination and thresholds are configurable via settings.
        dd_conf = s.get("deadlock_detection") or {}
        deadlock_detector: Optional[DeadlockDetector] = None
        if dd_conf.get("enabled", True):
            deadlock_detector = DeadlockDetector(
                signals=tuple(dd_conf.get("signals", DEADLOCK_DEFAULT_SIGNALS)),
                window=dd_conf.get("window", 3),
                route_similarity_threshold=dd_conf.get("route_similarity_threshold", 0.8),
                text_similarity_threshold=dd_conf.get("text_similarity_threshold", 0.8),
                num_participants=max(1, len(self.participants)),
                max_interventions=dd_conf.get("max_interventions", -1),
                cooldown_turns=dd_conf.get("cooldown_turns", 6),
            )

        if not global_goals:
            raise RuntimeError("global_goals must be provided (via argument or constructor).")

        # Convert constraints dict to text if needed
        constraints_text: Optional[str] = None
        if isinstance(constraints, dict):
            constraints_text = build_constraints_text(constraints)
        elif isinstance(constraints, str):
            constraints_text = constraints

        # Extract a structured time window for mechanical route validation
        # (the other constraints stay prompt-only). Pre-formatted constraint
        # strings are matched against the build_constraints_text format.
        tw_start_text: Optional[str] = None
        tw_end_text: Optional[str] = None
        if isinstance(constraints, dict):
            tw_start_text = (constraints.get("time_window_start") or "").strip() or None
            tw_end_text = (constraints.get("time_window_end") or "").strip() or None
        elif constraints_text:
            m = re.search(r"Time Window:\s*(\S+)\s*-\s*(\S+)", constraints_text)
            if m:
                tw_start_text, tw_end_text = m.group(1), m.group(2)
            else:
                m = re.search(r"Start Time:\s*(\S+)", constraints_text)
                tw_start_text = m.group(1) if m else None
                m = re.search(r"End Time:\s*(\S+)", constraints_text)
                tw_end_text = m.group(1) if m else None
        supported_turn_rules = {"round_robin", "inviting", "facilitating", "random"}
        if turn_rule not in supported_turn_rules:
            raise NotImplementedError(f"turn_rule '{turn_rule}' is not supported.")
        supported_voting_rules = {"majority", "unanimous", "most_pleasure", "least_misery", "single_decider"}
        if voting_rule not in supported_voting_rules:
            raise NotImplementedError(f"voting_rule '{voting_rule}' is not supported.")

        # Resolve the designated decider ("__YOU__" = the human participant).
        # An unset or stale name falls back to the first participant in order.
        single_decider_display: Optional[str] = None
        if voting_rule == "single_decider":
            valid_deciders = {p.name for p in self.participants}
            if self._human_enabled:
                valid_deciders.add("__YOU__")
            if single_decider not in valid_deciders:
                ordered = [n for n in (self._order or []) if n in valid_deciders]
                single_decider = ordered[0] if ordered else self.participants[0].name
            single_decider_display = (
                self._human_name if single_decider == "__YOU__" else single_decider
            )
        else:
            single_decider = None

        meeting_workflow_text = build_meeting_workflow_text(
            turn_rule, voting_rule, vote_turn_rule, balanced_turns, volunteer_mode,
            single_decider=single_decider_display,
        )
        for p in self.participants:
            if title is not None:
                p.meeting_title = title
            if constraints_text is not None:
                p.constraints_text = constraints_text
            p.time_window_start = tw_start_text
            p.time_window_end = tw_end_text
            p.meeting_workflow = meeting_workflow_text

        self._stop = asyncio.Event()
        self._drain_human_queues()
        if not (resume_from_history and self.history):
            self.history = []

        self.analytics.meeting_started()
        yield MeetingStarted(goal=global_goals)

        participant_lookup = {p.name: p for p in self.participants}
        order = [name for name in self._order if name in participant_lookup or name == "__YOU__"] if self._order else []
        if not order:
            order = [p.name for p in self.participants]
        else:
            for pname in participant_lookup:
                if pname not in order:
                    order.append(pname)
        all_participant_names = order[:]

        turn = 0
        if resume_from_history:
            # Continue turn numbering where the restored history left off.
            # GUI events are keyed by (turn, speaker); if a resumed run
            # reused old turn numbers, the frontend would merge the new
            # turns into existing chat entries instead of appending them.
            for msg in self.history:
                t = (getattr(msg, "additional_kwargs", {}) or {}).get("turn")
                if isinstance(t, int) and t > turn:
                    turn = t
        start_time = time.monotonic()
        system_history_name = sanitize_name("System")
        round_number = 0
        current_route: Optional[List[Any]] = None
        current_route_destinations: Optional[List[Dict[str, Any]]] = None
        current_route_proposer: Optional[str] = None
        current_route_representative_score: Optional[float] = None
        has_accepted_proposal = False
        proposal_count = 0
        satisfied_tracker: Dict[str, bool] = {
            name: False for name in all_participant_names
        }
        # The human's action loop is bounded like the LLMs': it gets the largest
        # per-turn action budget among the LLM participants (min 1).
        human_max_steps = max((p.max_steps for p in self.participants), default=1)
        human_max_steps = max(1, human_max_steps)

        def time_exceeded() -> bool:
            return time_limit is not None and (time.monotonic() - start_time) >= time_limit

        def emit_phase_marker(title: str, description: Optional[str] = None):
            text = title if not description else f"{title}\n{description}"
            self.history.append(AIMessage(content=text, name=system_history_name))
            yield PhaseMessage(title=title, description=description)

        # ── Helper functions (reused from initialization) ──

        def parse_duration_minutes(text: Optional[str]) -> Optional[int]:
            if not text:
                return None
            lowered = text.strip().lower()
            if not lowered:
                return None
            hours = 0.0
            minutes = 0.0
            match = re.search(r"(\d+(?:\.\d+)?)\s*(?:h|hr|hour|hours|時間)", lowered)
            if match:
                hours = float(match.group(1))
            match = re.search(r"(\d+(?:\.\d+)?)\s*(?:m|min|minute|minutes|分)", lowered)
            if match:
                minutes = float(match.group(1))
            if hours == 0.0 and minutes == 0.0:
                fallback = re.search(r"(\d+(?:\.\d+)?)", lowered)
                if fallback:
                    minutes = float(fallback.group(1))
            total = hours * 60 + minutes
            return int(total) if total > 0 else None

        def format_minutes(total: int) -> str:
            if total <= 0:
                return "0m"
            hours, minutes = divmod(total, 60)
            if hours and minutes:
                return f"{hours}h {minutes}m"
            if hours:
                return f"{hours}h"
            return f"{minutes}m"

        def parse_time_to_minutes(text: Optional[str]) -> Optional[int]:
            """Parse 'HH:MM' or 'H:MM' to minutes from midnight."""
            if not text:
                return None
            m = re.match(r"(\d{1,2}):(\d{2})", text.strip())
            if m:
                return int(m.group(1)) * 60 + int(m.group(2))
            return None

        def minutes_to_time_str(mins: int) -> str:
            """Convert minutes from midnight to 'HH:MM'."""
            h, m = divmod(mins, 60)
            return f"{h:02d}:{m:02d}"

        def correct_route_times(destinations_payload: List[Dict[str, Any]]) -> List[str]:
            """Fix start_times that are impossible given previous stop's timing.

            Only adjusts when the declared start_time is earlier than the
            earliest possible arrival.  Returns a list of adjustment notes.
            Modifies *destinations_payload* in-place.
            """
            adjustments: List[str] = []
            for i in range(1, len(destinations_payload)):
                prev = destinations_payload[i - 1]
                curr = destinations_payload[i]
                prev_start = parse_time_to_minutes(prev.get("start_time"))
                prev_stay = parse_duration_minutes(prev.get("stay_duration"))
                curr_travel = parse_duration_minutes(curr.get("travel_time_from_previous"))
                curr_start = parse_time_to_minutes(curr.get("start_time"))
                if None in (prev_start, prev_stay, curr_travel, curr_start):
                    continue
                earliest = prev_start + prev_stay + curr_travel
                if curr_start < earliest:
                    old_time = curr["start_time"]
                    new_time = minutes_to_time_str(earliest)
                    curr["start_time"] = new_time
                    curr["original_start_time"] = old_time
                    adjustments.append(
                        f"- {curr.get('name', '?')}: {old_time} -> {new_time}"
                    )
            return adjustments

        def route_window_violations(destinations_payload: List[Dict[str, Any]]) -> List[str]:
            """Stops that fall outside the meeting's time window.

            The window is enforced with retry feedback while the proposer
            regenerates the route; this re-check catches proposals that still
            violate it after the retry budget, so the violation can be
            surfaced to the group (who can reject the proposal in voting).
            """
            notes: List[str] = []
            tw_start = parse_time_to_minutes(tw_start_text)
            tw_end = parse_time_to_minutes(tw_end_text)
            if not destinations_payload or (tw_start is None and tw_end is None):
                return notes
            first_start = parse_time_to_minutes(destinations_payload[0].get("start_time"))
            if tw_start is not None and first_start is not None and first_start < tw_start:
                notes.append(
                    f"- {destinations_payload[0].get('name', '?')}: starts at "
                    f"{destinations_payload[0].get('start_time')} before the time window start ({tw_start_text})"
                )
            if tw_end is not None:
                for d in destinations_payload:
                    start = parse_time_to_minutes(d.get("start_time"))
                    stay = parse_duration_minutes(d.get("stay_duration"))
                    if start is None or stay is None:
                        continue
                    if start + stay > tw_end:
                        notes.append(
                            f"- {d.get('name', '?')}: ends at {minutes_to_time_str(start + stay)} "
                            f"past the time window end ({tw_end_text})"
                        )
            return notes

        def format_route_detail(
            destinations: List[Dict[str, Any]],
            proposer_name: Optional[str] = None,
        ) -> str:
            """Format destinations as a detailed numbered list."""
            lines: List[str] = []
            if proposer_name:
                lines.append(f"Proposed by {proposer_name}:")
            for i, d in enumerate(destinations, 1):
                line = f"{i}. {d.get('name', 'Unknown')}"
                parts: List[str] = []
                if d.get("start_time"):
                    parts.append(d["start_time"])
                if d.get("stay_duration"):
                    parts.append(f"{d['stay_duration']} stay")
                if d.get("cost"):
                    parts.append(d["cost"])
                if parts:
                    line += f" ({', '.join(parts)})"
                if d.get("transport_mode") and d.get("travel_time_from_previous"):
                    line += f" - {d['transport_mode']} {d['travel_time_from_previous']}"
                if d.get("description"):
                    line += f": {d['description']}"
                lines.append(line)
            return "\n".join(lines)

        def _sanitize_destination_entry(entry: Any) -> Optional[Dict[str, Any]]:
            if isinstance(entry, Destination):
                try:
                    return entry.model_dump(exclude_none=True)
                except Exception:
                    entry = entry.dict()
            if isinstance(entry, dict):
                cleaned: Dict[str, Any] = {}
                for key in (
                    "name", "description", "start_time", "stay_duration",
                    "travel_time_from_previous", "transport_mode", "cost", "transport_cost",
                ):
                    if key not in entry:
                        continue
                    value = entry.get(key)
                    if value is None:
                        continue
                    if isinstance(value, (int, float)):
                        value = str(value)
                    cleaned[key] = value
                if cleaned.get("name") or any(cleaned.values()):
                    return cleaned
            return None

        def serialize_destinations(destinations: List[Any]) -> List[Dict[str, Any]]:
            payload: List[Dict[str, Any]] = []
            for dest in destinations or []:
                sanitized = _sanitize_destination_entry(dest)
                if sanitized:
                    payload.append(sanitized)
            return payload

        def compute_route_summary(destinations_payload: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
            if not destinations_payload:
                return None
            total_stay = 0
            total_travel = 0
            cost_texts: List[Optional[str]] = []
            first_time_raw = None
            last_time_raw = None
            for dest in destinations_payload:
                stay = parse_duration_minutes(dest.get("stay_duration"))
                if stay:
                    total_stay += stay
                travel = parse_duration_minutes(dest.get("travel_time_from_previous"))
                if travel:
                    total_travel += travel
                cost_texts.append(dest.get("cost"))
                cost_texts.append(dest.get("transport_cost"))
                start_time_val = dest.get("start_time")
                if start_time_val:
                    if first_time_raw is None:
                        first_time_raw = start_time_val
                    last_time_raw = start_time_val
            summary: Dict[str, Any] = {}
            # Compute total duration from start_time span when possible
            first_mins = parse_time_to_minutes(first_time_raw)
            last_mins = parse_time_to_minutes(last_time_raw)
            last_stay = parse_duration_minutes(destinations_payload[-1].get("stay_duration")) if destinations_payload else None
            if first_mins is not None and last_mins is not None and last_stay:
                total_duration = (last_mins + last_stay) - first_mins
            else:
                total_duration = total_stay + total_travel
            if total_duration:
                summary["total_duration"] = format_minutes(total_duration)
            if total_stay:
                summary["stay_duration"] = format_minutes(total_stay)
            if total_travel:
                summary["travel_duration"] = format_minutes(total_travel)
            free_time = total_duration - total_stay - total_travel if total_duration else 0
            if free_time > 0:
                summary["free_time"] = format_minutes(free_time)
            total_cost_text = format_cost_totals(cost_texts)
            if total_cost_text:
                summary["total_cost"] = total_cost_text
            summary["spots_count"] = len(destinations_payload)
            if first_time_raw and last_mins is not None and last_stay:
                end_time = minutes_to_time_str(last_mins + last_stay)
                summary["time_window"] = f"{first_time_raw} - {end_time}"
            elif first_time_raw and last_time_raw:
                summary["time_window"] = f"{first_time_raw} - {last_time_raw}"
            return summary

        def create_retry_callback(queue: asyncio.Queue[Dict[str, Any]]):
            async def on_retry(attempt: int, max_attempts: int, error_msg: str):
                await queue.put({"retry": {
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "error_message": error_msg,
                }})
            return on_retry

        # ── Voting selection functions ──

        # ── Speaking position helpers ──

        def _ordinal(n: int) -> str:
            """Return ordinal string for an integer (1 -> '1st', 2 -> '2nd', etc.)."""
            if 11 <= (n % 100) <= 13:
                suffix = "th"
            else:
                suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
            return f"{n}{suffix}"

        def compute_position_info(
            turn_index: int, total_speakers: int,
        ) -> tuple:
            """Return (speaking_position, position_guidance) for prompt injection."""
            pos_1 = turn_index + 1
            speaking_position = f"{_ordinal(pos_1)} of {total_speakers}"

            if pos_1 == 1:
                guidance = (
                    "As the first speaker this round, you have the opportunity "
                    "to set the agenda and frame the key issues for discussion."
                )
            elif pos_1 == total_speakers:
                guidance = (
                    "As the final speaker this round, synthesize what others "
                    "have said and try to identify areas of agreement or propose compromises."
                )
            else:
                guidance = (
                    "Build on what previous speakers have said. You can support, "
                    "challenge, or redirect the discussion."
                )
            return speaking_position, guidance

        # ── Perform conversation turn (streaming) ──

        # Mutable container for passing results out of async generators
        _conv_turn_result: Dict[str, Any] = {}

        async def perform_conversation_turn(
            participant: Participant,
            other_names: List[str],
            assigned_turn: Optional[int] = None,
            speaking_position: Optional[str] = None,
            position_guidance: Optional[str] = None,
        ):
            nonlocal turn, current_route, current_route_destinations, current_route_proposer, has_accepted_proposal
            _conv_turn_result.clear()
            current_turn = assigned_turn
            if current_turn is None:
                turn += 1
                current_turn = turn

            self.analytics.turn_started(current_turn, participant.name)
            yield TurnStart(turn=current_turn, speaker=participant.name)
            queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()

            async def on_delta(delta: str, chunk: Dict[str, Any]):
                await queue.put({"delta": delta, "chunk": chunk or {}})

            # Ask handler: call target's answer_question, queue the exchange for yielding
            async def ask_handler_wrapper(target_name: str, question: str, asker_context: Optional[str] = None) -> str:
                # The human participant answers via the UI rather than the LLM.
                if self._is_human_ask_target(target_name):
                    return await self._human_ask_roundtrip(
                        queue, current_turn, participant.name, question, start_time, time_limit,
                    )
                target_p = participant_lookup.get(target_name)
                # Fallback: LLM may use sanitized name (underscores) instead of real name (spaces)
                if target_p is None:
                    target_p = participant_lookup.get(target_name.replace("_", " "))
                if target_p is None:
                    return f"(Participant '{target_name}' not found.)"
                current_route_text = ""
                if current_route_destinations:
                    current_route_text = format_route_detail(
                        current_route_destinations, current_route_proposer,
                    )
                # Include the asker's in-progress steps so the answerer has context
                hist = self.history
                if asker_context:
                    hist = list(self.history)
                    hist.append(AIMessage(
                        content=f"[Steps]\n{asker_context}",
                        name=sanitize_name(participant.name),
                        additional_kwargs={},
                    ))
                other_names = [n for n in participant_lookup if n != target_p.name]
                # Surface the question immediately so the UI can show it (with a
                # "typing" placeholder for the target) while the answer streams.
                await queue.put({
                    "ask_pending": {
                        "turn": current_turn,
                        "asker": participant.name,
                        "target": target_p.name,
                        "question": question,
                    }
                })
                response = await target_p.answer_question(
                    asker_name=participant.name,
                    question=question,
                    history=hist,
                    meeting_goal=global_goals,
                    current_route_text=current_route_text or "No accepted route yet.",
                    other_participant_names=other_names,
                )
                # Record LLM calls from answer_question
                if target_p.last_llm_calls:
                    self.analytics.record_llm_calls([
                        {**c, "turn": current_turn, "speaker": target_p.name}
                        for c in target_p.last_llm_calls
                    ])
                # Queue ask exchange for yielding later
                await queue.put({
                    "ask_exchange": {
                        "turn": current_turn,
                        "asker": participant.name,
                        "target": target_p.name,
                        "question": question,
                        "response": response,
                    }
                })
                return response

            _crt = (
                format_route_detail(current_route_destinations, current_route_proposer)
                if current_route_destinations
                else "No accepted route yet."
            )
            free_turn_task = asyncio.create_task(
                participant.free_turn(
                    other_participant_names=other_names,
                    history=self.history,
                    current_route=current_route,
                    current_route_destinations=current_route_destinations,
                    current_route_text=_crt,
                    meeting_goal=global_goals,
                    round_number=round_number,
                    has_accepted_proposal=has_accepted_proposal,
                    progress_callback=on_delta,
                    ask_handler=ask_handler_wrapper,
                    retry_callback=create_retry_callback(queue),
                    allow_search=participant.web_search,
                    volunteer_mode=volunteer_mode,
                    speaking_position=speaking_position,
                    position_guidance=position_guidance,
                )
            )
            queue_task = asyncio.create_task(queue.get())
            spoken = ""
            success = False
            result = None
            steps_log_parts: List[str] = []
            steps_label: Optional[str] = None

            try:
                while True:
                    done, _ = await asyncio.wait(
                        {free_turn_task, queue_task}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if queue_task in done:
                        item = queue_task.result()
                        # Handle retry notification
                        if "retry" in item:
                            retry_info = item["retry"]
                            yield RetryNotification(
                                turn=current_turn,
                                speaker=participant.name,
                                attempt=retry_info["attempt"],
                                max_attempts=retry_info["max_attempts"],
                                error_message=retry_info["error_message"],
                            )
                            queue_task = asyncio.create_task(queue.get())
                            continue
                        # stop() aborted a pending human ask: cancel the
                        # asker's turn without recording anything.
                        if "stop_abort" in item:
                            free_turn_task.cancel()
                            with suppress(asyncio.CancelledError, Exception):
                                await free_turn_task
                            break
                        # Handle ask (question surfaced before the answer)
                        if "ask_pending" in item:
                            ap = item["ask_pending"]
                            yield AskPending(
                                turn=ap["turn"],
                                asker=ap["asker"],
                                target=ap["target"],
                                question=ap["question"],
                            )
                            queue_task = asyncio.create_task(queue.get())
                            continue
                        # Prompt the human to answer an LLM's question.
                        if "human_ask" in item:
                            ha = item["human_ask"]
                            yield HumanAsk(
                                turn=ha["turn"],
                                asker=ha["asker"],
                                target=ha["target"],
                                question=ha["question"],
                                conversation_history=self.get_conversation_history(),
                            )
                            queue_task = asyncio.create_task(queue.get())
                            continue
                        # Handle ask exchange
                        if "ask_exchange" in item:
                            ex = item["ask_exchange"]
                            yield AskExchange(
                                turn=ex["turn"],
                                asker=ex["asker"],
                                target=ex["target"],
                                question=ex["question"],
                                response=ex["response"],
                            )
                            if ex.get("response"):
                                steps_log_parts.append(f"AskA: {ex['response']}")
                            queue_task = asyncio.create_task(queue.get())
                            continue

                        delta = item.get("delta")
                        chunk = item.get("chunk") or {}
                        metadata = self._extract_internal_metadata(chunk)

                        if delta:
                            spoken += delta
                        if delta or metadata:
                            yield Delta(
                                turn=current_turn,
                                speaker=participant.name,
                                delta=delta or "",
                                metadata=metadata,
                            )
                        # Accumulate internal log
                        if metadata and "internal_event" in metadata:
                            ie = metadata["internal_event"]
                            et = ie.get("event_type")
                            if et == "thinking_step":
                                sn = ie.get("step_number")
                                ms = ie.get("max_steps")
                                ac = ie.get("action")
                                th = ie.get("thought", "")
                                qr = ie.get("query")
                                at = ie.get("ask_target")
                                if sn and ms:
                                    log_line = f"[Step {sn}/{ms}"
                                    if ac:
                                        log_line += f" - {ac}"
                                    log_line += "]"
                                    steps_log_parts.append(log_line)
                                if th:
                                    steps_log_parts.append(th)
                                if qr:
                                    steps_log_parts.append(f"Search: {qr}")
                                if at:
                                    steps_log_parts.append(f"Ask: {at}")
                            elif et == "search_results":
                                obs = ie.get("observation", "")
                                if obs:
                                    steps_log_parts.append(obs)
                            if not steps_label:
                                steps_label = ie.get("task_label")
                        queue_task = asyncio.create_task(queue.get())
                    if free_turn_task in done:
                        result = await free_turn_task
                        success = True
                        break
            except Exception as exc:
                logger.exception("Free conversation turn failed for %s", participant.name)
                if is_authentication_error(exc):
                    raise RuntimeError(
                        f"Meeting aborted: LLM authentication failed for {participant.name} "
                        f"({exc}). Set your API keys (docker/.env or GUI Settings) and retry."
                    ) from exc
                error_text = self._format_turn_error("participate in free conversation", exc)
                for chunk_text in self._chunk_text(error_text):
                    yield Delta(turn=current_turn, speaker=participant.name, delta=chunk_text)
                yield TurnFinal(turn=current_turn, speaker=participant.name, text=error_text)
                self.history.append(
                    AIMessage(
                        content=error_text,
                        name=sanitize_name(participant.name),
                        additional_kwargs=self._build_additional_kwargs(current_turn),
                    )
                )
            finally:
                queue_task.cancel()
                with suppress(asyncio.CancelledError):
                    await queue_task

            # Drain remaining queue items
            while not queue.empty():
                try:
                    item = queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                if "ask_pending" in item:
                    ap = item["ask_pending"]
                    yield AskPending(
                        turn=ap["turn"], asker=ap["asker"],
                        target=ap["target"], question=ap["question"],
                    )
                    continue
                if "ask_exchange" in item:
                    ex = item["ask_exchange"]
                    yield AskExchange(
                        turn=ex["turn"], asker=ex["asker"], target=ex["target"],
                        question=ex["question"], response=ex["response"],
                    )
                    if ex.get("response"):
                        steps_log_parts.append(f"AskA: {ex['response']}")
                    continue
                delta = item.get("delta")
                chunk = item.get("chunk") or {}
                metadata = self._extract_internal_metadata(chunk)
                if delta:
                    spoken += delta
                if delta or metadata:
                    yield Delta(
                        turn=current_turn, speaker=participant.name,
                        delta=delta or "", metadata=metadata,
                    )
                if metadata and "internal_event" in metadata:
                    ie = metadata["internal_event"]
                    et = ie.get("event_type")
                    if et == "thinking_step":
                        sn = ie.get("step_number")
                        ms = ie.get("max_steps")
                        ac = ie.get("action")
                        th = ie.get("thought", "")
                        qr = ie.get("query")
                        at = ie.get("ask_target")
                        if sn and ms:
                            log_line = f"[Step {sn}/{ms}"
                            if ac:
                                log_line += f" - {ac}"
                            log_line += "]"
                            steps_log_parts.append(log_line)
                        if th:
                            steps_log_parts.append(th)
                        if qr:
                            steps_log_parts.append(f"Search: {qr}")
                        if at:
                            steps_log_parts.append(f"Ask: {at}")
                    elif et == "search_results":
                        obs = ie.get("observation", "")
                        if obs:
                            steps_log_parts.append(obs)
                    if not steps_label:
                        steps_label = ie.get("task_label")

            if not success or result is None:
                return  # async generator just stops; _conv_turn_result stays empty

            # Pass: emit TurnFinal but don't add to history (no message spoken)
            conclusion = result.get("conclusion", "continue")
            if conclusion == "pass":
                yield TurnFinal(
                    turn=current_turn, speaker=participant.name,
                    text="", steps_label="pass",
                )
                _conv_turn_result.update(result)
                return

            # Emit remaining public message as deltas
            message = result.get("message", "")
            message = str(message) if message else ""
            spoken = str(spoken) if spoken else ""
            suffix = message[len(spoken):] if message.startswith(spoken) else message
            if suffix:
                for chunk_text in self._chunk_text(suffix):
                    yield Delta(turn=current_turn, speaker=participant.name, delta=chunk_text)

            # Build route plan if proposal
            route_plan_payload = None
            route_adjustments: List[str] = []
            route_draft = result.get("route_draft")
            if route_draft is not None and hasattr(route_draft, "route"):
                destinations_payload = serialize_destinations(route_draft.route)
                route_adjustments = correct_route_times(destinations_payload)
                if route_adjustments:
                    self.analytics.record_time_corrections(current_turn, participant.name, route_adjustments)
                route_sequence = [
                    dest.get("name", "") for dest in destinations_payload if dest.get("name")
                ]
                summary_payload = compute_route_summary(destinations_payload)
                route_plan_payload = {"route": route_sequence, "destinations": destinations_payload}
                if summary_payload:
                    route_plan_payload["summary"] = summary_payload

            # Build steps log (for UI — excludes terminal action)
            conclusion = result.get("conclusion", "continue")
            steps_log = "\n".join(steps_log_parts) if steps_log_parts else None
            task_label = conclusion if conclusion == "satisfied" else steps_label

            self.analytics.turn_finished(current_turn, participant.name, message, participant.last_token_usage)
            if participant.last_llm_calls:
                self.analytics.record_llm_calls([
                    {**c, "turn": current_turn, "speaker": participant.name}
                    for c in participant.last_llm_calls
                ])
            if participant.last_compaction_event:
                self.analytics.record_compaction(
                    participant.name, current_turn,
                    participant.last_compaction_event["tokens_before"],
                    participant.last_compaction_event["tokens_after"],
                )
                participant.last_compaction_event = None

            yield TurnFinal(
                turn=current_turn,
                speaker=participant.name,
                text=message,
                route_plan=route_plan_payload,
                steps_log=steps_log,
                steps_label=task_label,
                max_steps=participant.max_steps,
            )

            # Build history steps log (includes terminal action). Proposals
            # already streamed a "[Step N/M - conclude]" entry, so don't add a
            # second terminal step for them.
            has_conclude_step = any(
                part.startswith("[Step") and part.endswith("- conclude]")
                for part in steps_log_parts
            )
            if conclusion != "pass" and message and not has_conclude_step:
                total_steps = result.get("total_steps", "?")
                r_max_steps = result.get("max_steps", "?")
                steps_log_parts.append(f"[Step {total_steps}/{r_max_steps} - {conclusion}]\n{message}")
            history_steps_log = "\n".join(steps_log_parts) if steps_log_parts else None

            additional: Dict[str, Any] = {"route_plan": route_plan_payload} if route_plan_payload else {}
            if steps_log:
                additional["steps_log"] = steps_log
            if task_label:
                additional["steps_label"] = task_label
            additional["max_steps"] = participant.max_steps
            additional["public_text"] = message
            # Include steps and route details in history content
            if route_plan_payload and route_plan_payload.get("destinations"):
                route_text = format_route_detail(route_plan_payload["destinations"])
                route_block = f"[Route Proposal]\n{route_text}"
                if route_adjustments:
                    route_block += "\nThe following destinations had their arrival times corrected because the proposed times were too early:\n" + "\n".join(route_adjustments)
                window_notes = route_window_violations(route_plan_payload["destinations"])
                if window_notes:
                    route_block += "\nWarning: this proposal violates the meeting's time window:\n" + "\n".join(window_notes)
                if history_steps_log:
                    history_content = f"[Steps]\n{history_steps_log}\n\n{route_block}"
                else:
                    history_content = f"{route_block}"
            else:
                history_content = f"[Steps]\n{history_steps_log}" if history_steps_log else message
            self.history.append(
                AIMessage(
                    content=history_content,
                    name=sanitize_name(participant.name),
                    additional_kwargs=self._build_additional_kwargs(current_turn, additional),
                )
            )
            _conv_turn_result.update(result)

        # ── Inline proposal voting ──

        async def run_proposal_voting(
            proposer_name: str,
            route_draft: RouteDraft,
            route_plan_payload: Dict[str, Any],
            proposer_key: Optional[str] = None,
        ):
            # ``proposer_key`` is the internal order key used to exclude the
            # proposer from the voter list (e.g. "__YOU__" for the human);
            # ``proposer_name`` is the display name used in labels/analytics.
            proposer_key = proposer_key or proposer_name
            nonlocal turn, current_route, current_route_destinations, current_route_proposer, current_route_representative_score, has_accepted_proposal, proposal_count
            proposal_count += 1
            ordinal = _ordinal(proposal_count)

            # Build text summary of proposed route for voting prompt
            proposed_dests = route_plan_payload.get("destinations") or []
            proposed_route_text = format_route_detail(proposed_dests, proposer_name) if proposed_dests else "No details available."

            # Current route text
            current_route_text_for_vote = "No accepted route yet."
            if current_route_destinations:
                current_route_text_for_vote = format_route_detail(
                    current_route_destinations, current_route_proposer,
                )
            if voting_rule == "most_pleasure":
                if current_route_representative_score is None:
                    current_route_score_for_vote = "No current route score available."
                else:
                    current_route_score_for_vote = (
                        "Current route representative score (sum of voter scores): "
                        f"{current_route_representative_score:.2f}"
                    )
            elif voting_rule == "least_misery":
                if current_route_representative_score is None:
                    current_route_score_for_vote = "No current route score available."
                else:
                    current_route_score_for_vote = (
                        "Current route representative score (minimum voter score): "
                        f"{current_route_representative_score:.2f}"
                    )
            else:
                current_route_score_for_vote = "No current route score available."

            proposal_entry = {
                "id": 1,
                "participant": proposer_name,
                "message": route_draft.message if hasattr(route_draft, "message") else "",
                "route": [
                    dest.get("name", "") for dest in proposed_dests
                ],
                "destinations": proposed_dests,
            }
            proposals = [proposal_entry]

            for event in emit_phase_marker(
                f"{ordinal} Proposal Voting",
                f"{proposer_name}'s proposal is being voted on.",
            ):
                yield event

            vote_records: List[Dict[str, Any]] = []
            voter_names = [n for n in all_participant_names if n != proposer_key]
            if voting_rule == "single_decider" and single_decider is not None:
                # Only the designated decider casts a vote; a proposal by the
                # decider carries an implicit self-accept (no voting round).
                proposer_is_decider = (
                    proposer_key == single_decider
                    or proposer_name in (single_decider, single_decider_display)
                )
                voter_names = [] if proposer_is_decider else [single_decider]

            # Create vote-specific TurnSelector
            vote_done: Dict[str, bool] = {n: False for n in voter_names}
            _vote_phase_events: List[PhaseMessage] = []
            def _vote_phase_cb(title: str, description: str) -> None:
                _vote_phase_events.append(PhaseMessage(title=title, description=description))

            sequential_voting = bool(voter_names) and (
                vote_turn_rule != "parallel" or self._human_enabled
            )
            if sequential_voting:
                vote_selector = create_selector(
                    turn_rule=vote_turn_rule,
                    order=voter_names,
                    satisfied_tracker=vote_done,
                    volunteer_mode=False,
                    balanced_turns=True,
                    participant_lookup=participant_lookup,
                    history_ref=self.history,
                    meeting_goal=global_goals,
                    phase_callback=_vote_phase_cb,
                    initial_inviter=proposer_name,
                )
                vote_selector.start_round()

            while sequential_voting:
                voter_name = await vote_selector.next_speaker()

                # Record LLM calls from vote selector (decide_next_speaker)
                if vote_selector.last_llm_calls:
                    self.analytics.record_llm_calls([
                        {**c, "turn": turn} for c in vote_selector.last_llm_calls
                    ])

                # Flush phase events from vote selector
                for pe in _vote_phase_events:
                    text = pe.title if not pe.description else f"{pe.title}\n{pe.description}"
                    self.history.append(AIMessage(content=text, name=system_history_name))
                    yield pe
                _vote_phase_events.clear()

                if voter_name is None:
                    break
                if self._stop.is_set():
                    break
                if time_exceeded():
                    yield Timeout()
                    yield MeetingFinished(turns=turn)
                    return

                # Handle human voter — a multi-step loop: ask (intermediate) an
                # LLM, then judge (final: accept/reject, or a score).
                if voter_name == "__YOU__" and self._human_enabled:
                    turn += 1
                    self.analytics.turn_started(turn, self._human_name)
                    yield TurnStart(turn=turn, speaker=self._human_name)

                    vote_candidates = _human_ask_candidates("__YOU__")
                    vote_data = None
                    vote_timed_out = False
                    v_human_steps_parts: List[str] = []
                    vote_ask_exchanges: List[Dict[str, Any]] = []
                    for v_step in range(1, human_max_steps + 1):
                        v_can_ask = bool(vote_candidates) and v_step < human_max_steps
                        yield HumanVote(
                            turn=turn,
                            speaker=self._human_name,
                            vote_type="route",
                            options={"proposals": proposals, "voting_rule": voting_rule},
                            step=v_step, max_steps=human_max_steps,
                            candidates=vote_candidates, can_ask=v_can_ask,
                            conversation_history=self.get_conversation_history(),
                            ask_exchanges=list(vote_ask_exchanges),
                        )

                        remaining_time = None
                        if time_limit is not None:
                            elapsed = time.monotonic() - start_time
                            remaining_time = max(0.0, time_limit - elapsed)

                        try:
                            if self._human_vote_queue is None:
                                self._human_vote_queue = asyncio.Queue()
                            action = await (
                                asyncio.wait_for(self._human_vote_queue.get(), timeout=remaining_time)
                                if remaining_time is not None
                                else self._human_vote_queue.get()
                            )
                        except asyncio.TimeoutError:
                            yield Timeout()
                            yield MeetingFinished(turns=turn)
                            return

                        # A stop() unblock sentinel is an empty payload.
                        if self._stop.is_set() and not action:
                            break
                        if not isinstance(action, dict):
                            action = {}

                        if action.get("action") == "ask":
                            target = action.get("target") or action.get("ask_target") or ""
                            question = (action.get("message") or "").strip()
                            async for ev in run_human_ask(
                                target, question, turn, v_step, human_max_steps,
                                v_human_steps_parts,
                                exchanges=vote_ask_exchanges,
                            ):
                                yield ev
                            continue

                        # Any non-ask payload is the final judgment.
                        vote_data = action
                        break

                    # Stopped or exhausted the step budget without judging: end
                    # this voting round without recording a vote.
                    if vote_data is None:
                        if self._stop.is_set():
                            break
                        vote_done[voter_name] = True
                        continue

                    is_score_rule = voting_rule in {"most_pleasure", "least_misery"}
                    human_accept = vote_data.get("accept", vote_data.get("route_id") == 1)
                    human_score: Optional[float] = None
                    human_scores_payload = vote_data.get("scores")
                    if is_score_rule:
                        if isinstance(human_scores_payload, list):
                            route_scores: List[float] = []
                            for entry in human_scores_payload:
                                if not isinstance(entry, dict):
                                    continue
                                try:
                                    rid = int(entry.get("route_id"))
                                except (TypeError, ValueError):
                                    continue
                                if rid != 1:
                                    continue
                                try:
                                    route_scores.append(float(entry.get("score")))
                                except (TypeError, ValueError):
                                    continue
                            if route_scores:
                                human_score = sum(route_scores) / len(route_scores)
                        if human_score is None:
                            raw_score = vote_data.get("score")
                            if isinstance(raw_score, (int, float)):
                                human_score = float(raw_score)
                        if human_score is not None:
                            human_accept = human_score >= 5.0
                    vote_record = {
                        "participant": self._human_name,
                        "accept": human_accept,
                        "message": vote_data.get("message", ""),
                    }
                    if isinstance(human_scores_payload, list):
                        vote_record["scores"] = human_scores_payload
                    if human_score is not None:
                        vote_record["score"] = human_score
                    vote_records.append(vote_record)
                    self.analytics.vote_recorded(
                        voter=self._human_name,
                        votee=proposer_name,
                        score=self._analytics_vote_score(
                            voting_rule=voting_rule,
                            vote_obj={"accept": human_accept, **vote_data},
                        ),
                        turn=turn,
                        approved=bool(human_accept),
                    )
                    if is_score_rule and human_score is not None:
                        vote_summary_text = f"[Score: {human_score:.1f}]"
                    else:
                        verdict = "Accept" if human_accept else "Reject"
                        vote_summary_text = f"[{verdict}]"
                    if vote_data.get("message"):
                        vote_summary_text = f"{vote_data['message']} {vote_summary_text}"
                    self.analytics.turn_finished(turn, self._human_name, vote_summary_text)

                    # Render the vote like an LLM voter's reply: the comment is
                    # the spoken text, the verdict is a steps_label badge, and any
                    # asks show as inline steps under the proposal.
                    human_vote_comment = vote_data.get("message", "")
                    human_vote_verdict = "scoring" if is_score_rule else (
                        "accept" if human_accept else "reject"
                    )
                    human_vote_steps_log = (
                        "\n".join(v_human_steps_parts) if v_human_steps_parts else None
                    )
                    yield TurnFinal(
                        turn=turn,
                        speaker=self._human_name,
                        text=human_vote_comment,
                        steps_log=human_vote_steps_log,
                        steps_label=human_vote_verdict,
                        max_steps=human_max_steps,
                        score=human_score,
                    )
                    human_vote_additional = self._build_additional_kwargs(turn)
                    if human_score is not None:
                        human_vote_additional["score"] = human_score
                    human_vote_additional["public_text"] = human_vote_comment
                    human_vote_additional["steps_label"] = human_vote_verdict
                    human_vote_additional["max_steps"] = human_max_steps
                    if human_vote_steps_log:
                        human_vote_additional["steps_log"] = human_vote_steps_log
                        v_history_content = (
                            f"[Steps]\n{human_vote_steps_log}\n\n"
                            f"[{human_vote_verdict}]\n{human_vote_comment}"
                        )
                    else:
                        v_history_content = f"[{human_vote_verdict}]\n{human_vote_comment}"
                    self.history.append(
                        HumanMessage(
                            content=v_history_content,
                            name=sanitize_name(self._human_name),
                            additional_kwargs=human_vote_additional,
                        )
                    )
                    vote_done[voter_name] = True
                    continue

                voter = participant_lookup.get(voter_name)
                if voter is None:
                    continue

                # Show the LLM the human's display name (not the __YOU__ sentinel)
                # so it can address/ask the human.
                other_names = self._display_participant_names(
                    [n for n in all_participant_names if n != voter_name]
                )
                turn += 1
                current_vote_turn = turn
                self.analytics.turn_started(current_vote_turn, voter.name)
                yield TurnStart(turn=current_vote_turn, speaker=voter.name)

                vote_queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()

                async def on_vote_delta(delta: str, chunk: Dict[str, Any]):
                    await vote_queue.put({"delta": delta, "chunk": chunk or {}})

                # Ask handler for vote action loop
                async def vote_ask_handler(target_name: str, question: str, asker_context: Optional[str] = None) -> str:
                    # The human participant answers via the UI rather than the LLM.
                    if self._is_human_ask_target(target_name):
                        return await self._human_ask_roundtrip(
                            vote_queue, current_vote_turn, voter.name, question, start_time, time_limit,
                        )
                    target_p = participant_lookup.get(target_name)
                    if target_p is None:
                        target_p = participant_lookup.get(target_name.replace("_", " "))
                    if target_p is None:
                        return f"(Unknown participant: {target_name})"
                    # Include the voter's in-progress steps so the answerer has context
                    hist = self.history
                    if asker_context:
                        hist = list(self.history)
                        hist.append(AIMessage(
                            content=f"[Steps]\n{asker_context}",
                            name=sanitize_name(voter.name),
                            additional_kwargs={},
                        ))
                    other_names_vote = [n for n in participant_lookup if n != target_p.name]
                    await vote_queue.put({
                        "ask_pending": {
                            "turn": current_vote_turn,
                            "asker": voter.name,
                            "target": target_p.name,
                            "question": question,
                        }
                    })
                    resp = await target_p.answer_question(
                        asker_name=voter.name,
                        question=question,
                        history=hist,
                        meeting_goal=global_goals,
                        current_route_text=current_route_text_for_vote,
                        other_participant_names=other_names_vote,
                    )
                    # Record LLM calls from answer_question
                    if target_p.last_llm_calls:
                        self.analytics.record_llm_calls([
                            {**c, "turn": current_vote_turn, "speaker": target_p.name}
                            for c in target_p.last_llm_calls
                        ])
                    await vote_queue.put({
                        "ask_exchange": {
                            "turn": current_vote_turn,
                            "asker": voter.name,
                            "target": target_p.name,
                            "question": question,
                            "response": resp,
                        }
                    })
                    return resp

                vote_task = asyncio.create_task(
                    voter.vote_route(
                        other_names,
                        self.history,
                        proposer_name=proposer_name,
                        proposed_route_text=proposed_route_text,
                        current_route_text=current_route_text_for_vote,
                        current_route_score=current_route_score_for_vote,
                        voting_rule=voting_rule,
                        meeting_goal=global_goals,
                        progress_callback=on_vote_delta,
                        retry_callback=create_retry_callback(vote_queue),
                        allow_search=voter.web_search,
                        ask_handler=vote_ask_handler,
                    )
                )
                vq_task = asyncio.create_task(vote_queue.get())
                vote_spoken = ""
                vote_success = False
                vote_obj = None
                v_steps_log_parts: List[str] = []
                v_steps_label: Optional[str] = None

                def _accumulate_vote_internal(metadata):
                    nonlocal v_steps_label
                    if not metadata or "internal_event" not in metadata:
                        return
                    ie = metadata["internal_event"]
                    et = ie.get("event_type")
                    if et == "thinking_step":
                        sn, ms, ac = ie.get("step_number"), ie.get("max_steps"), ie.get("action")
                        th, qr = ie.get("thought", ""), ie.get("query")
                        at = ie.get("ask_target")
                        if sn and ms:
                            log_line = f"[Step {sn}/{ms}" + (f" - {ac}" if ac else "") + "]"
                            v_steps_log_parts.append(log_line)
                        if th:
                            v_steps_log_parts.append(th)
                        if qr:
                            v_steps_log_parts.append(f"Search: {qr}")
                        if at:
                            v_steps_log_parts.append(f"Ask: {at}")
                    elif et == "search_results":
                        obs = ie.get("observation", "")
                        if obs:
                            v_steps_log_parts.append(obs)
                    if not v_steps_label:
                        v_steps_label = ie.get("task_label")

                try:
                    while True:
                        done, _ = await asyncio.wait(
                            {vote_task, vq_task}, return_when=asyncio.FIRST_COMPLETED
                        )
                        if vq_task in done:
                            item = vq_task.result()
                            if "retry" in item:
                                retry_info = item["retry"]
                                yield RetryNotification(
                                    turn=current_vote_turn,
                                    speaker=voter.name,
                                    attempt=retry_info["attempt"],
                                    max_attempts=retry_info["max_attempts"],
                                    error_message=retry_info["error_message"],
                                )
                                vq_task = asyncio.create_task(vote_queue.get())
                                continue
                            # stop() aborted a pending human ask: cancel the
                            # voter's turn without recording anything.
                            if "stop_abort" in item:
                                vote_task.cancel()
                                with suppress(asyncio.CancelledError, Exception):
                                    await vote_task
                                break
                            if "ask_pending" in item:
                                ap = item["ask_pending"]
                                yield AskPending(
                                    turn=ap["turn"], asker=ap["asker"],
                                    target=ap["target"], question=ap["question"],
                                )
                                vq_task = asyncio.create_task(vote_queue.get())
                                continue
                            if "human_ask" in item:
                                ha = item["human_ask"]
                                yield HumanAsk(
                                    turn=ha["turn"], asker=ha["asker"],
                                    target=ha["target"], question=ha["question"],
                                    conversation_history=self.get_conversation_history(),
                                )
                                vq_task = asyncio.create_task(vote_queue.get())
                                continue
                            if "ask_exchange" in item:
                                ex = item["ask_exchange"]
                                yield AskExchange(
                                    turn=ex["turn"], asker=ex["asker"], target=ex["target"],
                                    question=ex["question"], response=ex["response"],
                                )
                                if ex.get("response"):
                                    v_steps_log_parts.append(f"AskA: {ex['response']}")
                                vq_task = asyncio.create_task(vote_queue.get())
                                continue
                            delta = item.get("delta")
                            chunk = item.get("chunk") or {}
                            metadata = self._extract_internal_metadata(chunk)
                            if delta:
                                vote_spoken += delta
                            if delta or metadata:
                                yield Delta(
                                    turn=current_vote_turn, speaker=voter.name,
                                    delta=delta or "", metadata=metadata,
                                )
                            _accumulate_vote_internal(metadata)
                            vq_task = asyncio.create_task(vote_queue.get())
                        if vote_task in done:
                            vote_obj = await vote_task
                            vote_success = True
                            break
                except Exception as exc:
                    logger.exception("Vote failed for %s", voter.name)
                    if is_authentication_error(exc):
                        raise RuntimeError(
                            f"Meeting aborted: LLM authentication failed for {voter.name} "
                            f"({exc}). Set your API keys (docker/.env or GUI Settings) and retry."
                        ) from exc
                    error_text = self._format_turn_error("vote on proposal", exc)
                    for ct in self._chunk_text(error_text):
                        yield Delta(turn=current_vote_turn, speaker=voter.name, delta=ct)
                    yield TurnFinal(turn=current_vote_turn, speaker=voter.name, text=error_text)
                    self.history.append(
                        AIMessage(
                            content=error_text,
                            name=sanitize_name(voter.name),
                            additional_kwargs=self._build_additional_kwargs(current_vote_turn),
                        )
                    )
                finally:
                    vq_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await vq_task

                # Drain remaining vote queue
                while not vote_queue.empty():
                    try:
                        item = vote_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    if "ask_pending" in item:
                        ap = item["ask_pending"]
                        yield AskPending(
                            turn=ap["turn"], asker=ap["asker"],
                            target=ap["target"], question=ap["question"],
                        )
                        continue
                    if "ask_exchange" in item:
                        ex = item["ask_exchange"]
                        yield AskExchange(
                            turn=ex["turn"], asker=ex["asker"], target=ex["target"],
                            question=ex["question"], response=ex["response"],
                        )
                        if ex.get("response"):
                            v_steps_log_parts.append(f"AskA: {ex['response']}")
                        continue
                    delta = item.get("delta")
                    chunk = item.get("chunk") or {}
                    metadata = self._extract_internal_metadata(chunk)
                    if delta:
                        vote_spoken += delta
                    if delta or metadata:
                        yield Delta(
                            turn=current_vote_turn, speaker=voter.name,
                            delta=delta or "", metadata=metadata,
                        )
                    _accumulate_vote_internal(metadata)

                if not vote_success or vote_obj is None:
                    if self._stop.is_set():
                        break
                    continue

                vote_record = {
                    "participant": voter.name,
                    "message": vote_obj["message"],
                    "accept": vote_obj["accept"],
                }
                if "scores" in vote_obj:
                    vote_record["scores"] = vote_obj.get("scores")
                if "score" in vote_obj:
                    vote_record["score"] = vote_obj.get("score")
                vote_records.append(vote_record)
                self.analytics.vote_recorded(
                    voter=voter.name,
                    votee=proposer_name,
                    score=self._analytics_vote_score(
                        voting_rule=voting_rule,
                        vote_obj=vote_obj,
                    ),
                    turn=current_vote_turn,
                    approved=bool(vote_obj.get("accept")),
                )

                history_text = vote_obj["message"]
                vote_spoken = str(vote_spoken) if vote_spoken else ""
                suffix = history_text[len(vote_spoken):] if history_text.startswith(vote_spoken) else history_text
                if suffix:
                    for ct in self._chunk_text(suffix):
                        yield Delta(turn=current_vote_turn, speaker=voter.name, delta=ct)

                v_steps_log = "\n".join(v_steps_log_parts) if v_steps_log_parts else None
                is_score_rule = voting_rule in {"most_pleasure", "least_misery"}
                if is_score_rule:
                    vote_verdict = "scoring"
                else:
                    vote_verdict = "accept" if vote_obj["accept"] else "reject"
                turn_score: Optional[float] = None
                raw_turn_score = vote_obj.get("score")
                if isinstance(raw_turn_score, (int, float)):
                    turn_score = float(raw_turn_score)
                elif isinstance(raw_turn_score, str):
                    try:
                        turn_score = float(raw_turn_score)
                    except ValueError:
                        turn_score = None

                self.analytics.turn_finished(current_vote_turn, voter.name, history_text, voter.last_token_usage)
                if voter.last_llm_calls:
                    self.analytics.record_llm_calls([
                        {**c, "turn": current_vote_turn, "speaker": voter.name}
                        for c in voter.last_llm_calls
                    ])
                if voter.last_compaction_event:
                    self.analytics.record_compaction(
                        voter.name, current_vote_turn,
                        voter.last_compaction_event["tokens_before"],
                        voter.last_compaction_event["tokens_after"],
                    )
                    voter.last_compaction_event = None
                yield TurnFinal(
                    turn=current_vote_turn,
                    speaker=voter.name,
                    text=history_text,
                    steps_log=v_steps_log,
                    steps_label=vote_verdict,
                    max_steps=voter.max_steps,
                    score=turn_score,
                )
                v_additional: Dict[str, Any] = {}
                if v_steps_log:
                    v_additional["steps_log"] = v_steps_log
                v_additional["steps_label"] = vote_verdict
                v_additional["max_steps"] = voter.max_steps
                v_additional["public_text"] = history_text
                if turn_score is not None:
                    v_additional["score"] = turn_score
                # Include steps in history content so other participants can see them
                if v_steps_log:
                    v_history_content = f"[Steps]\n{v_steps_log}\n\n[{vote_verdict}]\n{history_text}"
                else:
                    v_history_content = f"[{vote_verdict}]\n{history_text}"
                self.history.append(
                    AIMessage(
                        content=v_history_content,
                        name=sanitize_name(voter.name),
                        additional_kwargs=self._build_additional_kwargs(current_vote_turn, v_additional),
                    )
                )
                vote_done[voter_name] = True

            # ── Parallel voting path ──
            if vote_turn_rule == "parallel" and not self._human_enabled:
                async def _run_one_parallel_vote(voter_p: Participant) -> Dict[str, Any]:
                    """Execute a single voter's vote_route(), buffering events."""
                    other_names = [n for n in all_participant_names if n != voter_p.name]
                    queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
                    events_buf: List[Dict[str, Any]] = []
                    steps_log_parts: List[str] = []
                    steps_label: Optional[str] = None
                    spoken = ""

                    async def on_delta(delta: str, chunk: Dict[str, Any]):
                        await queue.put({"delta": delta, "chunk": chunk or {}})

                    async def pv_ask_handler(
                        target_name: str, question: str, asker_context: Optional[str] = None,
                    ) -> str:
                        target_p = participant_lookup.get(target_name)
                        if target_p is None:
                            target_p = participant_lookup.get(target_name.replace("_", " "))
                        if target_p is None:
                            return f"(Unknown participant: {target_name})"
                        hist = self.history
                        if asker_context:
                            hist = list(self.history)
                            hist.append(AIMessage(
                                content=f"[Steps]\n{asker_context}",
                                name=sanitize_name(voter_p.name),
                                additional_kwargs={},
                            ))
                        other_names_vote = [n for n in participant_lookup if n != target_p.name]
                        resp = await target_p.answer_question(
                            asker_name=voter_p.name,
                            question=question,
                            history=hist,
                            meeting_goal=global_goals,
                            current_route_text=current_route_text_for_vote,
                            other_participant_names=other_names_vote,
                        )
                        if target_p.last_llm_calls:
                            events_buf.append({
                                "ask_llm_calls": list(target_p.last_llm_calls),
                                "ask_speaker": target_p.name,
                            })
                        await queue.put({
                            "ask_exchange": {
                                "asker": voter_p.name,
                                "target": target_name,
                                "question": question,
                                "response": resp,
                            }
                        })
                        return resp

                    vote_task = asyncio.create_task(
                        voter_p.vote_route(
                            other_names,
                            self.history,
                            proposer_name=proposer_name,
                            proposed_route_text=proposed_route_text,
                            current_route_text=current_route_text_for_vote,
                            current_route_score=current_route_score_for_vote,
                            voting_rule=voting_rule,
                            meeting_goal=global_goals,
                            progress_callback=on_delta,
                            retry_callback=create_retry_callback(queue),
                            allow_search=voter_p.web_search,
                            ask_handler=pv_ask_handler,
                        )
                    )
                    vq_task = asyncio.create_task(queue.get())
                    vote_obj = None
                    success = False
                    error_text = None

                    def _accum(metadata):
                        nonlocal steps_label
                        if not metadata or "internal_event" not in metadata:
                            return
                        ie = metadata["internal_event"]
                        et = ie.get("event_type")
                        if et == "thinking_step":
                            sn, ms, ac = ie.get("step_number"), ie.get("max_steps"), ie.get("action")
                            th, qr = ie.get("thought", ""), ie.get("query")
                            at = ie.get("ask_target")
                            if sn and ms:
                                log_line = f"[Step {sn}/{ms}" + (f" - {ac}" if ac else "") + "]"
                                steps_log_parts.append(log_line)
                            if th:
                                steps_log_parts.append(th)
                            if qr:
                                steps_log_parts.append(f"Search: {qr}")
                            if at:
                                steps_log_parts.append(f"Ask: {at}")
                        elif et == "search_results":
                            obs = ie.get("observation", "")
                            if obs:
                                steps_log_parts.append(obs)
                        if not steps_label:
                            steps_label = ie.get("task_label")

                    try:
                        while True:
                            done, _ = await asyncio.wait(
                                {vote_task, vq_task}, return_when=asyncio.FIRST_COMPLETED
                            )
                            if vq_task in done:
                                item = vq_task.result()
                                if "retry" in item:
                                    events_buf.append(item)
                                elif "ask_exchange" in item:
                                    ex = item["ask_exchange"]
                                    events_buf.append(item)
                                    if ex.get("response"):
                                        steps_log_parts.append(f"AskA: {ex['response']}")
                                else:
                                    delta = item.get("delta")
                                    chunk = item.get("chunk") or {}
                                    metadata = self._extract_internal_metadata(chunk)
                                    if delta:
                                        spoken += delta
                                    if delta or metadata:
                                        events_buf.append({"delta": delta or "", "metadata": metadata})
                                    _accum(metadata)
                                vq_task = asyncio.create_task(queue.get())
                            if vote_task in done:
                                vote_obj = await vote_task
                                success = True
                                break
                    except Exception as exc:
                        logger.exception("Parallel vote failed for %s", voter_p.name)
                        if is_authentication_error(exc):
                            raise RuntimeError(
                                f"Meeting aborted: LLM authentication failed for {voter_p.name} "
                                f"({exc}). Set your API keys (docker/.env or GUI Settings) and retry."
                            ) from exc
                        error_text = self._format_turn_error("vote on proposal", exc)
                    finally:
                        vq_task.cancel()
                        with suppress(asyncio.CancelledError):
                            await vq_task

                    # Drain remaining queue
                    while not queue.empty():
                        try:
                            item = queue.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                        if "ask_exchange" in item:
                            ex = item["ask_exchange"]
                            events_buf.append(item)
                            if ex.get("response"):
                                steps_log_parts.append(f"AskA: {ex['response']}")
                        else:
                            delta = item.get("delta")
                            chunk = item.get("chunk") or {}
                            metadata = self._extract_internal_metadata(chunk)
                            if delta:
                                spoken += delta
                            if delta or metadata:
                                events_buf.append({"delta": delta or "", "metadata": metadata})
                            _accum(metadata)

                    return {
                        "voter": voter_p,
                        "vote_obj": vote_obj,
                        "success": success,
                        "error_text": error_text,
                        "events": events_buf,
                        "steps_log_parts": steps_log_parts,
                        "steps_label": steps_label,
                        "spoken": spoken,
                    }

                # Execute all votes in parallel
                voters_for_pv = [
                    participant_lookup[n] for n in voter_names if participant_lookup.get(n)
                ]
                _pv_raw = await asyncio.gather(
                    *[_run_one_parallel_vote(v) for v in voters_for_pv],
                    return_exceptions=True,
                )

                # Replay events sequentially — one turn per voter
                for _pv_item in _pv_raw:
                    if isinstance(_pv_item, Exception):
                        logger.exception("Parallel vote gather error: %s", _pv_item)
                        continue
                    vr = _pv_item
                    voter = vr["voter"]
                    turn += 1
                    current_vote_turn = turn
                    self.analytics.turn_started(current_vote_turn, voter.name)
                    yield TurnStart(turn=current_vote_turn, speaker=voter.name)

                    # Replay buffered events
                    for item in vr["events"]:
                        if "retry" in item:
                            ri = item["retry"]
                            yield RetryNotification(
                                turn=current_vote_turn, speaker=voter.name,
                                attempt=ri["attempt"], max_attempts=ri["max_attempts"],
                                error_message=ri["error_message"],
                            )
                        elif "ask_exchange" in item:
                            ex = item["ask_exchange"]
                            yield AskExchange(
                                turn=current_vote_turn, asker=ex["asker"],
                                target=ex["target"], question=ex["question"],
                                response=ex["response"],
                            )
                        elif "ask_llm_calls" in item:
                            self.analytics.record_llm_calls([
                                {**c, "turn": current_vote_turn, "speaker": item["ask_speaker"]}
                                for c in item["ask_llm_calls"]
                            ])
                        elif "delta" in item:
                            yield Delta(
                                turn=current_vote_turn, speaker=voter.name,
                                delta=item["delta"], metadata=item.get("metadata"),
                            )

                    # Handle error case
                    if not vr["success"] or vr["vote_obj"] is None:
                        err = vr.get("error_text") or "[error] Vote failed"
                        for ct in self._chunk_text(err):
                            yield Delta(turn=current_vote_turn, speaker=voter.name, delta=ct)
                        yield TurnFinal(turn=current_vote_turn, speaker=voter.name, text=err)
                        self.history.append(
                            AIMessage(
                                content=err,
                                name=sanitize_name(voter.name),
                                additional_kwargs=self._build_additional_kwargs(current_vote_turn),
                            )
                        )
                        continue

                    vote_obj = vr["vote_obj"]
                    vote_record = {
                        "participant": voter.name,
                        "message": vote_obj["message"],
                        "accept": vote_obj["accept"],
                    }
                    if "scores" in vote_obj:
                        vote_record["scores"] = vote_obj.get("scores")
                    if "score" in vote_obj:
                        vote_record["score"] = vote_obj.get("score")
                    vote_records.append(vote_record)
                    self.analytics.vote_recorded(
                        voter=voter.name,
                        votee=proposer_name,
                        score=self._analytics_vote_score(
                            voting_rule=voting_rule,
                            vote_obj=vote_obj,
                        ),
                        turn=current_vote_turn,
                        approved=bool(vote_obj.get("accept")),
                    )

                    history_text = vote_obj["message"]
                    spoken = vr["spoken"]
                    suffix = history_text[len(spoken):] if history_text.startswith(spoken) else history_text
                    if suffix:
                        for ct in self._chunk_text(suffix):
                            yield Delta(turn=current_vote_turn, speaker=voter.name, delta=ct)

                    v_steps_log = "\n".join(vr["steps_log_parts"]) if vr["steps_log_parts"] else None
                    is_score_rule = voting_rule in {"most_pleasure", "least_misery"}
                    if is_score_rule:
                        vote_verdict = "scoring"
                    else:
                        vote_verdict = "accept" if vote_obj["accept"] else "reject"
                    turn_score: Optional[float] = None
                    raw_turn_score = vote_obj.get("score")
                    if isinstance(raw_turn_score, (int, float)):
                        turn_score = float(raw_turn_score)
                    elif isinstance(raw_turn_score, str):
                        try:
                            turn_score = float(raw_turn_score)
                        except ValueError:
                            turn_score = None

                    self.analytics.turn_finished(current_vote_turn, voter.name, history_text, voter.last_token_usage)
                    if voter.last_llm_calls:
                        self.analytics.record_llm_calls([
                            {**c, "turn": current_vote_turn, "speaker": voter.name}
                            for c in voter.last_llm_calls
                        ])
                    if voter.last_compaction_event:
                        self.analytics.record_compaction(
                            voter.name, current_vote_turn,
                            voter.last_compaction_event["tokens_before"],
                            voter.last_compaction_event["tokens_after"],
                        )
                        voter.last_compaction_event = None

                    yield TurnFinal(
                        turn=current_vote_turn,
                        speaker=voter.name,
                        text=history_text,
                        steps_log=v_steps_log,
                        steps_label=vote_verdict,
                        max_steps=voter.max_steps,
                        score=turn_score,
                    )
                    v_additional: Dict[str, Any] = {}
                    if v_steps_log:
                        v_additional["steps_log"] = v_steps_log
                    v_additional["steps_label"] = vote_verdict
                    v_additional["max_steps"] = voter.max_steps
                    v_additional["public_text"] = history_text
                    if turn_score is not None:
                        v_additional["score"] = turn_score
                    if v_steps_log:
                        v_history_content = f"[Steps]\n{v_steps_log}\n\n[{vote_verdict}]\n{history_text}"
                    else:
                        v_history_content = f"[{vote_verdict}]\n{history_text}"
                    self.history.append(
                        AIMessage(
                            content=v_history_content,
                            name=sanitize_name(voter.name),
                            additional_kwargs=self._build_additional_kwargs(current_vote_turn, v_additional),
                        )
                    )

            # Tally votes
            accept_count = sum(1 for v in vote_records if v.get("accept"))
            proposed_route_representative_score: Optional[float] = None
            if voting_rule == "most_pleasure":
                proposed_route_representative_score = self._route_representative_score(vote_records, mode="sum")
                if current_route_representative_score is None:
                    accepted = proposed_route_representative_score is not None
                else:
                    accepted = (
                        proposed_route_representative_score is not None
                        and proposed_route_representative_score >= current_route_representative_score
                    )
            elif voting_rule == "least_misery":
                proposed_route_representative_score = self._route_representative_score(vote_records, mode="min")
                if current_route_representative_score is None:
                    accepted = proposed_route_representative_score is not None
                else:
                    accepted = (
                        proposed_route_representative_score is not None
                        and proposed_route_representative_score >= current_route_representative_score
                    )
            elif voting_rule == "majority":
                accepted = self._is_majority_accepted(
                    vote_records,
                    include_proposer_implicit_accept=True,
                )
            elif voting_rule == "unanimous":
                accepted = self._is_unanimous_accepted(
                    vote_records,
                    include_proposer_implicit_accept=True,
                )
            elif voting_rule == "single_decider":
                if vote_records:
                    accepted = all(bool(v.get("accept")) for v in vote_records)
                else:
                    # The decider proposed this route; implicit self-accept.
                    accepted = True
            else:
                # Existing behavior for other voting modes in this flow.
                accepted = self._is_majority_accepted(vote_records, include_proposer_implicit_accept=False)

            vote_summary = {
                "total_votes": len(vote_records),
                "accepted": accepted,
                "accept_count": accept_count,
                "votes": [
                    {"participant": v["participant"], "accept": v.get("accept", False)}
                    for v in vote_records
                ],
            }
            if voting_rule in {"most_pleasure", "least_misery"}:
                vote_summary["current_route_representative_score"] = current_route_representative_score
                vote_summary["proposed_route_representative_score"] = proposed_route_representative_score

            if deadlock_detector is not None:
                # Vote rationales are tracked as their own repetition channel:
                # a voter re-stating the same objection every round is a
                # stronger deadlock symptom than varied turn messages.
                for v in vote_records:
                    deadlock_detector.observe_message(
                        v.get("participant") or "",
                        v.get("message") or "",
                        channel="vote",
                    )
                deadlock_detector.observe_proposal(
                    turn=turn,
                    proposer=proposer_name,
                    destinations=route_plan_payload.get("destinations") or [],
                    accepted=accepted,
                )

            if accepted:
                current_route = route_draft.route if hasattr(route_draft, "route") else None
                current_route_destinations = route_plan_payload.get("destinations")
                current_route_proposer = proposer_name
                self.final_route = current_route_destinations
                if voting_rule in {"most_pleasure", "least_misery"}:
                    current_route_representative_score = proposed_route_representative_score
                has_accepted_proposal = True
                self.analytics.proposal_accepted(agent_name=proposer_name)
                self.analytics.route_updated(
                    turn=turn,
                    route_data=route_plan_payload,
                    phase="accepted",
                )

                yield ProposalVoteResult(
                    turn=turn,
                    proposer=proposer_name,
                    accepted=True,
                    vote_summary=vote_summary,
                )
                yield RoutePlanUpdate(
                    turn=turn,
                    speaker=proposer_name,
                    route_plan=route_plan_payload,
                )
                for event in emit_phase_marker(f"{ordinal} Proposal Accepted", f"{proposer_name}'s route was accepted."):
                    yield event
            else:
                yield ProposalVoteResult(
                    turn=turn,
                    proposer=proposer_name,
                    accepted=False,
                    vote_summary=vote_summary,
                )
                for event in emit_phase_marker(f"{ordinal} Proposal Rejected", f"{proposer_name}'s route was rejected. Discussion continues."):
                    yield event

        # ── Human ask helper (human asks an LLM participant) ──

        def _human_ask_candidates(exclude_key: str) -> List[str]:
            """Display names of the LLM participants the human may ask."""
            return self._display_participant_names(
                [n for n in all_participant_names if n != exclude_key and n != "__YOU__"]
            )

        async def run_human_ask(
            target_display: str, question: str, ask_turn: int,
            step_number: int, max_steps: int, steps_parts: List[str],
            exchanges: Optional[List[Dict[str, Any]]] = None,
        ):
            """The human asks an LLM participant; that participant answers.

            Renders inline as an ``ask`` step inside the human's turn/vote box
            — the question as the step's thought, the target's answer threaded
            beneath — exactly like an LLM participant's ask (not a standalone
            card). Emits the same ``thinking_step`` / ``ask_exchange`` internal
            events an LLM emits, and appends the step fragment to ``steps_parts``
            so it lands in the turn's final steps_log too.
            """
            target_p = participant_lookup.get(target_display) or participant_lookup.get(
                (target_display or "").replace("_", " ")
            )
            # Surface the question immediately as an "ask" step (target avatar +
            # typing dots) while the answer is fetched.
            yield Delta(
                turn=ask_turn, speaker=self._human_name, delta="",
                metadata={"internal_event": {
                    "event_type": "thinking_step",
                    "step_number": step_number, "max_steps": max_steps,
                    "action": "ask", "thought": question, "ask_target": target_display,
                }},
            )
            if target_p is None:
                response = f"(Participant '{target_display}' not found.)"
            else:
                route_text = (
                    format_route_detail(current_route_destinations, current_route_proposer)
                    if current_route_destinations
                    else "No accepted route yet."
                )
                other_names = [n for n in participant_lookup if n != target_p.name]
                try:
                    response = await target_p.answer_question(
                        asker_name=self._human_name,
                        question=question,
                        history=self.history,
                        meeting_goal=global_goals,
                        current_route_text=route_text,
                        other_participant_names=other_names,
                    )
                except Exception as exc:
                    logger.exception("Answering the human's question failed for %s", target_p.name)
                    if is_authentication_error(exc):
                        raise RuntimeError(
                            f"Meeting aborted: LLM authentication failed for {target_p.name} "
                            f"({exc}). Set your API keys (docker/.env or GUI Settings) and retry."
                        ) from exc
                    response = self._format_turn_error("answer the question", exc)
                if target_p.last_llm_calls:
                    self.analytics.record_llm_calls([
                        {**c, "turn": ask_turn, "speaker": target_p.name}
                        for c in target_p.last_llm_calls
                    ])
            # Fill the answer in beneath the ask step.
            yield Delta(
                turn=ask_turn, speaker=self._human_name, delta="",
                metadata={"internal_event": {
                    "event_type": "ask_exchange",
                    "step_number": step_number, "max_steps": max_steps,
                    "target": target_display, "question": question, "response": response,
                }},
            )
            steps_parts.append(
                f"[Step {step_number}/{max_steps} - ask]\n{question}\n"
                f"Ask: {target_display}\nAskA: {response}"
            )
            if exchanges is not None:
                exchanges.append({
                    "target": target_display,
                    "question": question,
                    "response": response,
                })

        # ── Human turn handler ──

        _human_turn_result: Dict[str, Any] = {}

        async def handle_human_turn():
            """Drive the human's speaking turn as a multi-step action loop.

            Each step the human may ``ask`` an LLM (intermediate) or finish with
            ``speak`` / ``propose`` / ``satisfied``. Populates ``_conv_turn_result``
            so the shared post-turn processing (proposal voting, satisfied,
            discussion) handles the outcome exactly like an LLM turn.
            """
            nonlocal turn
            _human_turn_result.clear()
            _conv_turn_result.clear()
            turn += 1
            self.analytics.turn_started(turn, self._human_name)
            yield TurnStart(turn=turn, speaker=self._human_name)

            candidates = _human_ask_candidates("__YOU__")
            steps_log_parts: List[str] = []
            conclusion = "continue"
            message = ""
            route_draft: Optional[RouteDraft] = None
            need_modification = False
            concluded = False

            turn_ask_exchanges: List[Dict[str, Any]] = []
            for step in range(1, human_max_steps + 1):
                can_ask = bool(candidates) and step < human_max_steps
                yield HumanTurn(
                    turn=turn, speaker=self._human_name,
                    step=step, max_steps=human_max_steps,
                    candidates=candidates, can_ask=can_ask, can_propose=True,
                    current_route=list(current_route_destinations or []),
                    conversation_history=self.get_conversation_history(),
                    ask_exchanges=list(turn_ask_exchanges),
                )

                remaining_time = None
                if time_limit is not None:
                    elapsed = time.monotonic() - start_time
                    remaining_time = max(0.0, time_limit - elapsed)
                try:
                    if self._human_queue is None:
                        self._human_queue = asyncio.Queue()
                    payload = await (
                        asyncio.wait_for(self._human_queue.get(), timeout=remaining_time)
                        if remaining_time is not None
                        else self._human_queue.get()
                    )
                except asyncio.TimeoutError:
                    yield Timeout()
                    yield MeetingFinished(turns=turn)
                    return

                # A stop() unblock sentinel ("" / empty dict) is not a real
                # action: end without recording (the run loop breaks on _stop).
                is_empty_sentinel = (
                    not payload
                    or (isinstance(payload, str) and not payload.strip())
                    or (
                        isinstance(payload, dict)
                        and not (payload.get("action") or "").strip()
                        and not (payload.get("message") or "").strip()
                        and not payload.get("route")
                    )
                )
                if self._stop.is_set() and is_empty_sentinel:
                    return

                if not isinstance(payload, dict):
                    payload = {"action": "speak", "message": payload or ""}

                action = (payload.get("action") or "speak").strip()
                msg = (payload.get("message") or "").strip()

                if action == "ask":
                    target = payload.get("target") or payload.get("ask_target") or ""
                    # The ask renders inline as an "ask" step in the human's turn
                    # box (question + the target's answer), mirroring an LLM
                    # participant; the fragment lands in steps_log_parts so the
                    # final bubble keeps it.
                    async for ev in run_human_ask(
                        target, msg, turn, step, human_max_steps, steps_log_parts,
                        exchanges=turn_ask_exchanges,
                    ):
                        yield ev
                    continue

                # Final actions end the turn.
                if action == "propose":
                    conclusion = "proposal"
                    message = msg
                    raw_dests = payload.get("route") or []
                    dest_objs: List[Destination] = []
                    for d in raw_dests:
                        if isinstance(d, dict):
                            dest_objs.append(Destination(**{
                                k: d.get(k, "") for k in Destination.model_fields
                            }))
                    route_draft = RouteDraft(message=msg, route=dest_objs)
                elif action == "satisfied":
                    conclusion = "satisfied"
                    # No placeholder text: an empty comment shows only the
                    # "Satisfied" badge, a non-empty one shows the comment plus
                    # the badge — exactly like an LLM concluding as satisfied.
                    message = msg
                else:  # "speak" / anything else
                    conclusion = "continue"
                    message = msg
                    need_modification = bool(payload.get("need_modification"))
                concluded = True
                break

            if not concluded:
                # Exhausted the step budget on asks alone: end quietly.
                conclusion = "continue"
                message = ""

            steps_log = "\n".join(steps_log_parts) if steps_log_parts else None

            # Build the route-plan payload for a proposal so the turn card shows
            # the route (the shared block re-derives it for voting).
            route_plan_payload = None
            if conclusion == "proposal" and route_draft is not None:
                dests_payload = serialize_destinations(route_draft.route)
                correct_route_times(dests_payload)
                route_sequence = [d.get("name", "") for d in dests_payload if d.get("name")]
                summary_payload = compute_route_summary(dests_payload)
                route_plan_payload = {"route": route_sequence, "destinations": dests_payload}
                if summary_payload:
                    route_plan_payload["summary"] = summary_payload

            # Concluding as satisfied carries the "satisfied" badge, mirroring an
            # LLM turn that ends the same way (task_label == "satisfied").
            human_steps_label = "satisfied" if conclusion == "satisfied" else None

            # History content that the OTHER participants read. The "Satisfied"
            # badge is GUI-only metadata (steps_label) and is invisible to the
            # LLMs, so the satisfied action is also encoded in the message
            # content — a "[Step N/M - satisfied]" line exactly like an LLM turn,
            # with the ask steps preceding it. The empty case still yields the
            # bare marker so an LLM sees the agreement even without a comment.
            # ``message`` (the clean text) is preserved as public_text and drives
            # the GUI (TurnFinal.text) so the badge-only look is unchanged.
            if conclusion == "satisfied":
                satisfied_step = f"[Step {step}/{human_max_steps} - satisfied]"
                if message:
                    satisfied_step += f"\n{message}"
                history_content = "[Steps]\n" + "\n".join(steps_log_parts + [satisfied_step])
            else:
                history_content = message

            self.analytics.turn_finished(turn, self._human_name, message)
            yield TurnFinal(
                turn=turn, speaker=self._human_name, text=message,
                route_plan=route_plan_payload, steps_log=steps_log,
                steps_label=human_steps_label,
                max_steps=human_max_steps,
                need_modification=need_modification if conclusion == "continue" else None,
            )
            additional = self._build_additional_kwargs(turn)
            if route_plan_payload:
                additional["route_plan"] = route_plan_payload
            if steps_log:
                additional["steps_log"] = steps_log
            if human_steps_label:
                additional["steps_label"] = human_steps_label
            additional["public_text"] = message
            self.history.append(
                HumanMessage(
                    content=history_content,
                    name=sanitize_name(self._human_name),
                    additional_kwargs=additional,
                )
            )
            result = {
                "conclusion": conclusion,
                "message": message,
                "route_draft": route_draft,
                "need_modification": need_modification,
            }
            _human_turn_result.update(result)
            _conv_turn_result.update(result)

        # ── Main conversation loop ──

        for event in emit_phase_marker("Tour Meeting Started", "Discuss among participants and create a tour route that satisfies each participant's personal goals while staying aligned with the meeting goal!"):
            yield event

        # Phase events from selector (inviting/facilitating) are buffered here
        _pending_phase_events: List[PhaseMessage] = []

        def _phase_callback(title: str, description: str) -> None:
            _pending_phase_events.append(PhaseMessage(title=title, description=description))

        selector = create_selector(
            turn_rule=turn_rule,
            order=order,
            satisfied_tracker=satisfied_tracker,
            volunteer_mode=volunteer_mode,
            balanced_turns=balanced_turns,
            participant_lookup=participant_lookup,
            history_ref=self.history,
            meeting_goal=global_goals,
            phase_callback=_phase_callback,
            human_facilitator_key=human_facilitator_key,
        )
        human_facilitates = (
            isinstance(selector, FacilitatingSelector) and selector.facilitator_is_human
        )

        selector_exhausted = False
        while True:
            if balanced_turns:
                round_number += 1
                selector.start_round()
            consensus_reached = False

            while True:
                # Drain externally queued advice (inject_advice) so every
                # participant sees it starting from the upcoming turn.
                while self._advice_inbox:
                    advice_text, advice_source = self._advice_inbox.pop(0)
                    self.history.append(
                        AIMessage(
                            content=f"Advice from {advice_source}\n{advice_text}",
                            name=system_history_name,
                        )
                    )
                    yield AdviceInjected(
                        turn=turn + 1, source=advice_source, message=advice_text,
                    )

                if human_facilitates:
                    # The human is the facilitator: prompt them to pick the next
                    # speaker (the LLM path is bypassed). An empty candidate list
                    # means the round is exhausted.
                    candidates = selector.candidates()
                    if not candidates:
                        name = None
                    else:
                        yield HumanSelectSpeaker(
                            turn=turn + 1,
                            speaker=self._human_name,
                            candidates=list(candidates),
                            conversation_history=self.get_conversation_history(),
                        )
                        remaining_time = None
                        if time_limit is not None:
                            elapsed = time.monotonic() - start_time
                            remaining_time = max(0.0, time_limit - elapsed)
                        try:
                            if self._human_select_queue is None:
                                self._human_select_queue = asyncio.Queue()
                            picked = await (
                                asyncio.wait_for(self._human_select_queue.get(), timeout=remaining_time)
                                if remaining_time is not None
                                else self._human_select_queue.get()
                            )
                        except asyncio.TimeoutError:
                            yield Timeout()
                            self.analytics.meeting_finished(reason="timeout")
                            yield MeetingFinished(turns=turn)
                            return
                        if self._stop.is_set():
                            break
                        # Guard against a stale/invalid pick (e.g. stop sentinel).
                        if picked not in candidates:
                            picked = candidates[0]
                        selector.record_choice(picked)
                        if picked == "__YOU__":
                            marker_desc = f"{self._human_name} chose to speak next."
                        else:
                            marker_desc = f"{self._human_name} invited {picked} to speak next."
                        for event in emit_phase_marker(
                            "Facilitator Selected Next Speaker", marker_desc,
                        ):
                            yield event
                        name = picked
                else:
                    name = await selector.next_speaker()

                # Record LLM calls from selector (decide_next_speaker)
                if selector.last_llm_calls:
                    self.analytics.record_llm_calls([
                        {**c, "turn": turn + 1} for c in selector.last_llm_calls
                    ])

                # Flush phase events from selector (e.g. "X invites Y")
                for pe in _pending_phase_events:
                    text = pe.title if not pe.description else f"{pe.title}\n{pe.description}"
                    self.history.append(AIMessage(content=text, name=system_history_name))
                    yield pe
                _pending_phase_events.clear()

                if name is None:
                    if balanced_turns:
                        yield RoundEnd(round_number=round_number)
                    else:
                        selector_exhausted = True
                    break

                if self._stop.is_set():
                    break
                if time_exceeded():
                    yield Timeout()
                    self.analytics.meeting_finished(reason="timeout")
                    yield MeetingFinished(turns=turn)
                    return
                if max_turns is not None and turn >= max_turns:
                    self.analytics.meeting_finished(reason="max_turns")
                    yield MeetingFinished(turns=turn)
                    return

                # Handle the speaker's turn: the human via an interactive action
                # loop, an LLM via its own free-conversation turn. Both populate
                # _conv_turn_result and fall through to the shared handling below.
                if name == "__YOU__" and self._human_enabled:
                    participant = None
                    speaker_name = self._human_name
                    _conv_turn_result.clear()
                    timed_out = False
                    async for event in handle_human_turn():
                        if isinstance(event, (Timeout, MeetingFinished)):
                            yield event
                            timed_out = True
                            break
                        yield event
                    if timed_out:
                        return
                else:
                    participant = participant_lookup.get(name)
                    if participant is None:
                        selector.on_turn_complete(name, "skip", {})
                        continue
                    speaker_name = participant.name
                    # Show the LLM the human's display name (not the __YOU__
                    # sentinel) so it can address/ask the human.
                    other_names = self._display_participant_names(
                        [n for n in all_participant_names if n != name]
                    )

                    # Compute speaking position only when the meeting has cycles.
                    if balanced_turns:
                        _turn_idx = len(selector._spoken_this_round)
                        _total_speakers = len(all_participant_names)
                        _sp, _pg = compute_position_info(_turn_idx, _total_speakers)
                    else:
                        _sp, _pg = None, None

                    # Run free conversation turn
                    _conv_turn_result.clear()
                    async for event in perform_conversation_turn(
                        participant, other_names,
                        speaking_position=_sp, position_guidance=_pg,
                    ):
                        yield event

                turn_result = dict(_conv_turn_result)
                if self._stop.is_set() and not turn_result:
                    break
                if not turn_result:
                    selector.on_turn_complete(name, "skip", {})
                    continue

                conclusion = turn_result.get("conclusion", "continue")
                self.analytics.record_action(speaker_name, conclusion)
                if deadlock_detector is not None:
                    deadlock_detector.observe_message(
                        speaker_name, turn_result.get("message") or ""
                    )

                if conclusion == "pass":
                    # Volunteer mode: participant chose to pass
                    selector.on_turn_complete(name, "pass", turn_result)
                    continue

                if conclusion == "proposal":
                    # Proposal resets all satisfied flags (situation changed)
                    for k in satisfied_tracker:
                        satisfied_tracker[k] = False

                    route_draft = turn_result.get("route_draft")
                    if route_draft is not None and hasattr(route_draft, "route"):
                        destinations_payload = serialize_destinations(route_draft.route)
                        route_adjustments = correct_route_times(destinations_payload)
                        if route_adjustments:
                            self.analytics.record_time_corrections(turn, speaker_name, route_adjustments)
                        route_sequence = [
                            d.get("name", "") for d in destinations_payload if d.get("name")
                        ]

                        # Skip voting if route is empty/broken
                        if len(route_sequence) < 2:
                            logger.warning(
                                "Skipping vote on %s's proposal: only %d destinations",
                                speaker_name, len(route_sequence),
                            )
                            for event in emit_phase_marker(
                                "Proposal Skipped",
                                f"{speaker_name}'s proposal was skipped (insufficient destinations).",
                            ):
                                yield event
                            selector.on_turn_complete(name, "proposal_skipped", turn_result)
                            continue

                        summary_payload = compute_route_summary(destinations_payload)
                        rp_payload: Dict[str, Any] = {
                            "route": route_sequence,
                            "destinations": destinations_payload,
                        }
                        if summary_payload:
                            rp_payload["summary"] = summary_payload

                        self.analytics.proposal_made(
                            agent_name=speaker_name,
                            proposal_data=rp_payload,
                            turn=turn,
                        )

                        async for event in run_proposal_voting(
                            speaker_name, route_draft, rp_payload, proposer_key=name,
                        ):
                            if isinstance(event, (Timeout, MeetingFinished)):
                                yield event
                                return
                            yield event

                        # After voting, ensure proposer chooses the next speaker
                        # (for inviting/facilitating modes)
                        selector.set_last_speaker(name)

                elif conclusion == "satisfied":
                    satisfied_tracker[name] = True
                    s_count = sum(1 for v in satisfied_tracker.values() if v)
                    if deadlock_detector is not None:
                        deadlock_detector.observe_satisfied(turn, s_count)
                    self.analytics.record_satisfied_state(turn, speaker_name, s_count, len(satisfied_tracker))
                    yield SatisfiedUpdate(
                        turn=turn, speaker=speaker_name,
                        satisfied=True, satisfied_count=s_count,
                        total_count=len(satisfied_tracker),
                    )
                    # Check consensus after each satisfied
                    if has_accepted_proposal and all(satisfied_tracker.values()):
                        for event in emit_phase_marker(
                            "Consensus Reached",
                            "All participants are satisfied with the current route.",
                        ):
                            yield event
                        consensus_reached = True
                        selector.on_turn_complete(name, conclusion, turn_result)
                        break
                else:
                    # Discussion resets all satisfied flags (new points raised)
                    for k in satisfied_tracker:
                        satisfied_tracker[k] = False

                selector.on_turn_complete(name, conclusion, turn_result)

                # Deadlock check runs once per completed turn; on detection a
                # System mediation message is injected into the shared history
                # so every participant sees it on their next turn.
                if deadlock_detector is not None:
                    evidence = deadlock_detector.check(turn)
                    if evidence is not None:
                        intervention_text = deadlock_detector.build_intervention_message(evidence)
                        self.history.append(
                            AIMessage(
                                content=f"Deadlock Intervention\n{intervention_text}",
                                name=system_history_name,
                            )
                        )
                        self.analytics.record_deadlock_intervention(
                            turn, list(evidence.signals), intervention_text
                        )
                        logger.info(
                            "Deadlock intervention at turn %d (signals: %s)",
                            turn, ", ".join(evidence.signals),
                        )
                        yield DeadlockIntervention(
                            turn=turn,
                            message=intervention_text,
                            signals=list(evidence.signals),
                        )

            if consensus_reached or self._stop.is_set() or selector_exhausted:
                break

        reason = "consensus" if consensus_reached else "stopped"

        # ── Post-consensus satisfaction evaluation ──
        enable_post_eval = self._settings.get("enable_post_eval", True)
        if enable_post_eval and consensus_reached and current_route_destinations:
            route_text = format_route_detail(current_route_destinations)
            for pname, participant in participant_lookup.items():
                try:
                    eval_result = await participant.evaluate_final_route(route_text)
                    self.analytics.post_consensus_evaluations.append({
                        "name": pname,
                        "score": eval_result["score"],
                        "reason": eval_result["reason"],
                    })
                    logger.info(
                        "Post-consensus eval: %s scored %d/10 - %s",
                        pname, eval_result["score"], eval_result["reason"][:80],
                    )
                except Exception as exc:
                    logger.warning("Post-consensus eval failed for %s: %s", pname, exc)

        self.analytics.meeting_finished(reason=reason)
        yield MeetingFinished(turns=turn)


    async def start_stream(
        self,
        global_goals: str,
        turn_strategy: Literal[
            "round_robin",
            "inviting",
            "facilitating",
            "random",
        ] = "round_robin",
        memory_strategy: Literal["global"] = "global",
        consensus_threshold: float = 0.8,
        id: Optional[str] = None,
        time_limit: Optional[int] = None,  # seconds
        max_turns: Optional[int] = None,
        seed: int = 42,
        resume_from_history: bool = False,
    ) -> AsyncIterator[MeetingEvent]:
        if not self.participants and not self._human_enabled:
            raise RuntimeError("No participants have been added.")

        # 空ならデフォ順（AI→…→+ 人(任意)）
        if not self._order:
            self._order = [p.name for p in self.participants]
            if self._human_enabled:
                self._order.append("__YOU__")
        self._stop = asyncio.Event()
        self._drain_human_queues()
        existing_turns = 0
        if resume_from_history:
            if not self.history:
                self.history = []
            existing_turns = len(self.history)
        else:
            self.history = []
            existing_turns = 0
        yield MeetingStarted(goal=global_goals)

        start_t = time.monotonic()
        idx = 0
        turns = existing_turns

        def slots() -> List[str]:
            # 現在の参加者・人の有無に合わせて order をフィルタ
            names = {p.name for p in self.participants}
            s = [x for x in self._order if (x == "__YOU__" and self._human_enabled) or (x in names)]
            # fallback
            if not s:
                s = [p.name for p in self.participants]
                if self._human_enabled:
                    s.append("__YOU__")
            return s

        if resume_from_history:
            last_speaker: Optional[str] = None
            for msg in reversed(self.history):
                name = getattr(msg, "name", "")
                if name:
                    last_speaker = name
                    break
            if last_speaker:
                order_now_resume = slots()
                key = "__YOU__" if last_speaker == self._human_name else last_speaker
                if key in order_now_resume and order_now_resume:
                    idx = (order_now_resume.index(key) + 1) % len(order_now_resume)

        while (max_turns is None or turns < max_turns) and not self._stop.is_set():
            if time_limit is not None and (time.monotonic() - start_t) >= time_limit:
                yield Timeout(); break

            order_now = slots()
            if not order_now:
                break

            name = order_now[idx]

            if name == "__YOU__":
                print(self._human_name)
                # Human turn
                # Track analytics
                self.analytics.turn_started(turns + 1, self._human_name)
                yield TurnStart(turn=turns + 1, speaker=self._human_name)
                from .types import HumanTurn
                yield HumanTurn(
                    turn=turns + 1, speaker=self._human_name,
                    conversation_history=self.get_conversation_history(),
                )

                remaining = None
                if time_limit is not None:
                    elapsed = time.monotonic() - start_t
                    remaining = max(0.0, time_limit - elapsed)
                try:
                    if self._human_queue is None:
                        self._human_queue = asyncio.Queue()
                    human_text = await (asyncio.wait_for(self._human_queue.get(), timeout=remaining) if remaining is not None else self._human_queue.get())
                except asyncio.TimeoutError:
                    yield Timeout(); break

                # Action dicts (from the free-conversation UI) carry the text in
                # "message"; a bare string is the message itself.
                if isinstance(human_text, dict):
                    final_text = human_text.get("message", "") or ""
                else:
                    final_text = human_text or ""
                # A stop() unblock sentinel is not a real message.
                if self._stop.is_set() and not final_text.strip():
                    break
                # Track analytics
                self.analytics.turn_finished(turns + 1, self._human_name, final_text)
                yield TurnFinal(turn=turns + 1, speaker=self._human_name, text=final_text)
                self.history.append(
                    HumanMessage(
                        content=final_text,
                        name=sanitize_name(self._human_name),
                        additional_kwargs=self._build_additional_kwargs(turns + 1),
                    )
                )

            else:
                # AI turn
                sp = self._name_to_participant(name)
                if sp is None:
                    # 参加者が消えたなど
                    idx = (idx + 1) % len(order_now)
                    continue

                # Track analytics
                self.analytics.turn_started(turns + 1, sp.name)
                yield TurnStart(turn=turns + 1, speaker=sp.name)
                buffer: List[str] = []
                try:
                    other_participant_names = [
                        order_now[i] for i in range(len(order_now)) if i != idx
                    ]
                    async for piece in sp.speak_stream_async(other_participant_names, self.history):
                        buffer.append(piece)
                        yield Delta(turn=turns + 1, speaker=sp.name, delta=piece)
                except Exception as e:
                    buffer.append(f"[error] {type(e).__name__}: {e}")
                final_text = "".join(buffer)
                # Track analytics
                self.analytics.turn_finished(turns + 1, sp.name, final_text, sp.last_token_usage)
                if sp.last_llm_calls:
                    self.analytics.record_llm_calls([
                        {**c, "turn": turns + 1, "speaker": sp.name}
                        for c in sp.last_llm_calls
                    ])
                if sp.last_compaction_event:
                    self.analytics.record_compaction(
                        sp.name, turns + 1,
                        sp.last_compaction_event["tokens_before"],
                        sp.last_compaction_event["tokens_after"],
                    )
                    sp.last_compaction_event = None
                yield TurnFinal(turn=turns + 1, speaker=sp.name, text=final_text)
                self.history.append(
                    AIMessage(
                        content=final_text,
                        name=sanitize_name(sp.name),
                        additional_kwargs=self._build_additional_kwargs(turns + 1),
                    )
                )

            order_now = slots()  # 途中で変化してもズレないよう毎回取り直す
            idx = (idx + 1) % len(order_now)
            turns += 1

        yield MeetingFinished(turns=turns)

    def start(
        self,
        global_goals: str,
        turn_strategy: Literal[
            "round_robin",
            "random",
            "manual",
            "facilitating",
            "inviting",
            "voting"
        ] = "round_robin",
        memory_strategy: Literal["global"] = "global",
        consensus_threshold: float = 0.8,
        id: Optional[str] = None, # meeting id
        time_limit: Optional[int] = None, # second(s)
        max_turns: Optional[int] = None,
        seed: int = 42,
        resume_from_history: bool = False,
    ) -> None:
        if not self.participants:
            raise ValueError("No participants have been added.")

        # initialization
        if not (resume_from_history and self.history):
            self.history = []
        rng = random.Random(seed)
        start_t = time.monotonic()
        turns = 0

        # metting
        if turn_strategy == "round_robin":
            idx = 0
            while turns < max_turns:
                if time_limit is not None and (time.monotonic() - start_t) >= time_limit:
                    break
                
                speaker = self.participants[idx]
                other_participant_names = [
                    p.name for j, p in enumerate(self.participants) if j != idx
                ]
                text = speaker.speak(other_participant_names, self.history)
                print(speaker.name)
                print(text)
                print()
                if not text:
                    pass

                # increment
                idx = (idx + 1) % len(self.participants)
                turns += 1

        else:
            raise NotImplementedError(f"turn_strategy '{turn_strategy}' is not implemented yet.")

    def get_analytics_summary(self) -> Dict[str, Any]:
        """
        Get a comprehensive summary of all analytics metrics.

        Returns:
            Dictionary containing discussion dynamics and route characteristics metrics.
        """
        return self.analytics.get_summary()

    def export_analytics(self) -> Dict[str, Any]:
        """
        Export all raw analytics data for external analysis or visualization.

        Returns:
            Dictionary containing all analytics data including:
            - Discussion dynamics (activity, proposals, consensus)
            - Route characteristics (snapshots, transitions)
            - Metadata (timestamps, duration)
        """
        return self.analytics.export_to_dict()

    async def run_cli(self) -> None:
        """Run the meeting with CLI output (print events to stdout)."""
        print(f"[+] Starting meeting: {self._title}")
        print(f"    Participants: {', '.join(p.name for p in self.participants)}")
        print(f"    Max turns: {self._settings.get('max_turns', 'unlimited')}")
        print()

        async for event in self.run_free_conversation():
            line = format_event(event)
            if line is None:
                continue
            if isinstance(event, Delta) and event.delta:
                print(line, end="", flush=True)
            else:
                print(line, flush=True)

        print("\n[+] Done")

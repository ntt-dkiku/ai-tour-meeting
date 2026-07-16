"""Route drafting for the human participant's "Generate with AI" dialog.

Unlike everything in participant.py, this does not run "as" one of the
meeting's LLM participants: the human is drafting THEIR OWN proposal, so the
draft runs on a neutral assistant system prompt with only the meeting's
context (title / goal / constraints), no persona. The caller picks which LLM
to run on (the dialog's model picker); participants are only a source of LLM
configs, never of voice.
"""

import asyncio
import json as _json
import logging
from typing import Any, Dict, List, Optional

import litellm
from pydantic import ValidationError

from .llm import (
    build_litellm_kwargs,
    build_messages,
    extract_json,
    get_format_instructions,
)
from .participant import (
    LLMParseError,
    Participant,
    RouteDraft,
    _truncate_for_retry_context,
)

logger = logging.getLogger(__name__)

# Neutral assistant prompt: no persona, no speaking style — the human speaks
# for themselves; the assistant only turns their idea into a complete route.
SYS_ROUTE_DRAFT = """\
You are an AI assistant that helps users with tour planning.
Given the current route and user requests, generate or modify the tour route.

# The meeting settings are as follows:
## Meeting title
{meeting_title}

## Meeting goal
{meeting_goals}

## Constraints
{constraints_text}

# Rules
Always follow the rules below:
- NEVER make changes to anything the user has not explicitly specified. If anything is unclear, ask the user for clarification.
- If the user's message does not ask you to generate or modify the route (e.g. a greeting, a question, or small talk), reply only via the `message` field and return `route` as an empty list — the app then keeps their current route untouched.
- When you generate or modify a tour route, output the route in the following format:
{format_instructions}
"""

HUMAN_ROUTE_DRAFT_PROMPT = """\
# Currently accepted route (for reference)
{current_route_text}

# User request
{human_description}

# The route they have started so far (may be empty or partial)
{partial_route_text}
"""


# Every Destination field, in schema order. The prompt must carry ALL of them
# — if a field (e.g. travel_time_from_previous or cost) is missing, the model
# cannot copy it and silently reinvents its value on every chat message.
_DESTINATION_FIELDS = [
    "name",
    "description",
    "transport_mode",
    "transport_cost",
    "travel_time_from_previous",
    "start_time",
    "stay_duration",
    "cost",
]


def _partial_route_text(partial_route: Optional[List[Dict[str, Any]]]) -> str:
    """Render the human's in-progress route as prompt text.

    Emits the full destination objects as JSON (same shape as the output
    schema) so the model can preserve every unchanged field verbatim.
    """
    if not partial_route:
        return "(none yet)"
    stops = []
    for d in partial_route:
        if not isinstance(d, dict):
            continue
        stops.append({key: str(d.get(key) or "") for key in _DESTINATION_FIELDS})
    if not stops:
        return "(none yet)"
    return _json.dumps(stops, ensure_ascii=False, indent=2)


# How many prior dialog messages to include as conversation context.
_MAX_HISTORY_MESSAGES = 20


def _history_messages(history: Optional[List[Dict[str, str]]]) -> List[Dict[str, str]]:
    """Convert the dialog's chat log into litellm messages.

    Accepts entries shaped {"role": "user"|"ai"|"assistant", "content": str}
    and drops anything else. Only the most recent _MAX_HISTORY_MESSAGES are
    kept so a long refinement session cannot blow up the prompt.
    """
    converted: List[Dict[str, str]] = []
    for m in history or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = m.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        if role == "user":
            converted.append({"role": "user", "content": content})
        elif role in ("ai", "assistant"):
            converted.append({"role": "assistant", "content": content})
    return converted[-_MAX_HISTORY_MESSAGES:]


async def draft_route_for_human(
    llm,
    description: str,
    meeting_goal: Optional[str] = None,
    current_route_text: str = "",
    partial_route: Optional[List[Dict[str, Any]]] = None,
    meeting_title: str = "",
    constraints_text: str = "",
    history: Optional[List[Dict[str, str]]] = None,
    max_retries: int = 3,
    retry_delay: float = 1.0,
) -> RouteDraft:
    """Generate/complete a route from the human's free-text idea.

    Runs on *llm* with the neutral SYS_ROUTE_DRAFT system prompt. *history*
    is the refine dialog's prior chat (user/ai turns), inserted between the
    system prompt and the current request so the conversation carries over;
    the route state itself always travels via *partial_route*. Retries with
    error feedback (the failed output + parse error) up to *max_retries*,
    like Participant._retry_with_backoff.
    """
    payload = {
        "meeting_title": meeting_title or "(untitled)",
        "meeting_goals": meeting_goal or "",
        "constraints_text": constraints_text or "(none)",
        "current_route_text": current_route_text or "No accepted route yet.",
        "human_description": description or "(no description provided)",
        "partial_route_text": _partial_route_text(partial_route),
    }
    format_instr = get_format_instructions(RouteDraft)
    field_names = list(RouteDraft.model_fields.keys())

    last_exception: Optional[Exception] = None
    error_context: List[Dict[str, str]] = []
    for attempt in range(max_retries):
        try:
            messages = build_messages(
                system_template=SYS_ROUTE_DRAFT,
                history=_history_messages(history),
                payload=payload,
                format_instructions=format_instr,
                human_template=HUMAN_ROUTE_DRAFT_PROMPT,
            )
            messages.extend(error_context)
            response = await litellm.acompletion(
                messages=messages, **build_litellm_kwargs(llm)
            )
            content = response.choices[0].message.content or ""
            try:
                parsed = extract_json(content)
            except (ValueError, _json.JSONDecodeError) as exc:
                raise LLMParseError(str(exc), raw_output=content) from exc
            raw = {key: parsed.get(key) for key in field_names}
            sanitized = Participant._sanitize_route_payload(raw)
            try:
                return RouteDraft(**sanitized)
            except ValidationError as exc:
                raise LLMParseError(
                    str(exc),
                    raw_output=_json.dumps(sanitized, ensure_ascii=False, default=str),
                ) from exc
        except Exception as exc:  # noqa: BLE001 — feed the failure back and retry
            last_exception = exc
            raw_output = _truncate_for_retry_context(getattr(exc, "raw_output", ""))
            if raw_output:
                error_context.append({"role": "assistant", "content": raw_output})
                error_context.append({
                    "role": "user",
                    "content": (
                        f"Your output could not be parsed. Error: {exc}\n"
                        "Please output valid JSON matching the required schema."
                        f"\n\n{format_instr}"
                    ),
                })
            if attempt < max_retries - 1:
                wait_time = retry_delay * (2 ** attempt)
                logger.warning(
                    "Route draft failed (attempt %d/%d): %s. Retrying in %ss...",
                    attempt + 1, max_retries, exc, wait_time,
                )
                await asyncio.sleep(wait_time)
            else:
                logger.error(
                    "Route draft failed after %d attempts: %s", max_retries, exc
                )

    raise last_exception or RuntimeError("Route draft failed after all retries")

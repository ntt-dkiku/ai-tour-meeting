import asyncio
import logging
import re
import time
from typing import Any, Awaitable, Callable, Dict, List, Literal, Optional

import json as _json

import litellm
import tiktoken
from pydantic import BaseModel, Field, ValidationError

from .messages import AIMessage, HumanMessage
from .llm import (
    TokenTracker, build_litellm_kwargs, build_messages,
    extract_json, get_format_instructions,
)
from .search_engine import gpt5_search_sync


logger = logging.getLogger(__name__)

_tiktoken_enc = tiktoken.get_encoding("cl100k_base")


class LLMParseError(Exception):
    """Raised when LLM output cannot be parsed into the expected format."""
    def __init__(self, message: str, raw_output: str = ""):
        super().__init__(message)
        self.raw_output = raw_output


def _truncate_for_retry_context(text: str, max_len: int = 3000) -> str:
    value = (text or "").strip()
    if len(value) <= max_len:
        return value
    return value[: max_len - 3].rstrip() + "..."


def _safe_json_text(value: Any) -> str:
    try:
        return _json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)


# ── Route time validation ──

def _parse_time_to_minutes(text: Optional[str]) -> Optional[int]:
    """Parse 'HH:MM' or 'H:MM' to minutes from midnight."""
    if not text:
        return None
    m = re.match(r"(\d{1,2}):(\d{2})", text.strip())
    if m:
        return int(m.group(1)) * 60 + int(m.group(2))
    return None


def _parse_duration_minutes(text: Optional[str]) -> Optional[int]:
    """Parse duration strings like '60 min', '1h 30m' to total minutes."""
    if not text:
        return None
    lowered = text.strip().lower()
    if not lowered:
        return None
    hours = 0.0
    minutes = 0.0
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:h|hr|hour|hours)", lowered)
    if match:
        hours = float(match.group(1))
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:m|min|minute|minutes)", lowered)
    if match:
        minutes = float(match.group(1))
    if hours == 0.0 and minutes == 0.0:
        fallback = re.search(r"(\d+(?:\.\d+)?)", lowered)
        if fallback:
            minutes = float(fallback.group(1))
    total = hours * 60 + minutes
    return int(total) if total > 0 else None


def _minutes_to_time_str(mins: int) -> str:
    h, m = divmod(mins, 60)
    return f"{h:02d}:{m:02d}"


class RouteTimeViolation(Exception):
    """Raised when a proposed route has timing inconsistencies."""
    def __init__(self, message: str, raw_output: str = ""):
        super().__init__(message)
        self.raw_output = raw_output


class RouteCostViolation(Exception):
    """Raised when a proposed route has malformed cost values."""
    def __init__(self, message: str, raw_output: str = ""):
        super().__init__(message)
        self.raw_output = raw_output


# A currency symbol followed by a number (optionally with thousands
# separators / decimals), or the Japanese '500円' form. Empty is allowed
# separately (unknown cost).
_COST_PATTERN = re.compile(
    r"^\s*(?:[$¥€£₩₹₫₪฿]\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*円)\s*$"
)


def validate_route_costs(route_draft) -> List[str]:
    """Check a RouteDraft's cost/transport_cost fields for format violations.

    Every non-empty value must be a currency symbol plus a number (e.g.
    '$20', '¥1500') so route totals can be computed reliably — free-text
    values like 'Free entry (donation optional)' are rejected.

    Returns a list of human-readable violation descriptions.
    Empty list means the route is valid.
    """
    violations: List[str] = []
    destinations = route_draft.route if hasattr(route_draft, "route") else []
    for i, dest in enumerate(destinations, 1):
        name = getattr(dest, "name", "") or f"stop {i}"
        for field in ("cost", "transport_cost"):
            value = (getattr(dest, field, "") or "").strip()
            if value and not _COST_PATTERN.match(value):
                violations.append(
                    f"{name}: {field} '{value}' is not a currency symbol followed by a number. "
                    "Use a format like '$20' or '¥1500' ('$0'/'¥0' if free); "
                    "words or notes such as 'Free entry' are not allowed."
                )
    return violations


def validate_route_times(
    route_draft,
    time_window_start: Optional[str] = None,
    time_window_end: Optional[str] = None,
) -> List[str]:
    """Check a RouteDraft for timing violations.

    Beyond internal consistency (formats, reachable start times), stops that
    fall outside the meeting's time window ("HH:MM" strings, when given) are
    violations too.

    Returns a list of human-readable violation descriptions.
    Empty list means the route is valid.
    """
    violations: List[str] = []
    destinations = route_draft.route if hasattr(route_draft, "route") else []
    # Format checks first: timing fields that cannot be machine-parsed are
    # violations too, so the retry loop can ask the model to fix the format
    # instead of silently skipping the arithmetic check.
    for i, dest in enumerate(destinations, 1):
        name = getattr(dest, "name", "") or f"stop {i}"
        st_raw = getattr(dest, "start_time", "")
        if _parse_time_to_minutes(st_raw) is None:
            violations.append(
                f"{name}: start_time '{st_raw}' is not a parseable clock time. "
                "Use 24-hour 'HH:MM' (e.g., '09:30')."
            )
        stay_raw = getattr(dest, "stay_duration", "")
        if _parse_duration_minutes(stay_raw) is None:
            violations.append(
                f"{name}: stay_duration '{stay_raw}' is not a parseable duration. "
                "Use a format like '90 min'."
            )
        if i >= 2:
            tv_raw = getattr(dest, "travel_time_from_previous", "")
            if _parse_duration_minutes(tv_raw) is None:
                violations.append(
                    f"{name}: travel_time_from_previous '{tv_raw}' is not a parseable "
                    "duration. Use a format like '15 min' ('0 min' if adjacent)."
                )
    # Meeting time-window checks
    tw_start = _parse_time_to_minutes(time_window_start)
    tw_end = _parse_time_to_minutes(time_window_end)
    if destinations and tw_start is not None:
        first = destinations[0]
        first_start = _parse_time_to_minutes(getattr(first, "start_time", ""))
        if first_start is not None and first_start < tw_start:
            violations.append(
                f"{getattr(first, 'name', 'stop 1')}: start_time "
                f"{getattr(first, 'start_time', '?')} is before the meeting's "
                f"time window start ({time_window_start})."
            )
    if tw_end is not None:
        for i, dest in enumerate(destinations, 1):
            start = _parse_time_to_minutes(getattr(dest, "start_time", ""))
            stay = _parse_duration_minutes(getattr(dest, "stay_duration", ""))
            if start is None or stay is None:
                continue
            if start + stay > tw_end:
                violations.append(
                    f"{getattr(dest, 'name', '') or f'stop {i}'}: ends at "
                    f"{_minutes_to_time_str(start + stay)}, past the meeting's "
                    f"time window end ({time_window_end})."
                )

    if len(destinations) < 2:
        return violations

    for i in range(1, len(destinations)):
        prev = destinations[i - 1]
        curr = destinations[i]
        prev_start = _parse_time_to_minutes(getattr(prev, "start_time", ""))
        prev_stay = _parse_duration_minutes(getattr(prev, "stay_duration", ""))
        curr_travel = _parse_duration_minutes(getattr(curr, "travel_time_from_previous", ""))
        curr_start = _parse_time_to_minutes(getattr(curr, "start_time", ""))
        if None in (prev_start, prev_stay, curr_travel, curr_start):
            continue
        earliest = prev_start + prev_stay + curr_travel
        if curr_start < earliest:
            prev_name = getattr(prev, "name", f"stop {i}")
            curr_name = getattr(curr, "name", f"stop {i + 1}")
            violations.append(
                f"{curr_name}: start_time {getattr(curr, 'start_time', '?')} is too early. "
                f"Previous stop '{prev_name}' starts at {getattr(prev, 'start_time', '?')}, "
                f"stays {getattr(prev, 'stay_duration', '?')}, "
                f"then travel takes {getattr(curr, 'travel_time_from_previous', '?')}. "
                f"Earliest possible arrival is {_minutes_to_time_str(earliest)}."
            )
    return violations


#---------
# Prompts
#---------

#---------------
# System Prompt
#---------------
SYS_PARTICIPANT = """\
You are one of the participants in a collaborative tour planning meeting.
Your task is to actively take part in the discussion and help the group reach a shared itinerary that satisfies everyone's interest.
Please carefully read the information and follow the rules below.

# Your Persona
Always role-play as the following person:
- Name: {name} // The person's name.
- Role: {role} // The person's meeting role: "facilitator" moderates the discussion; "attendee" participates as a regular member.
- Background: {background} // The person's relevant context, experience, or situation.
- Personality: {personality} // The person's stable traits, such as cautious, curious, analytical, or sociable.
- Preferences: {preferences} // The person's likes, dislikes, priorities, and constraints.
- Personal Goals: {personal_goals} // The person's specific objectives for this tour-planning discussion.
- Speaking Style: {speaking_style} // The person's tone and manner of speaking
- Explanation Style: {explanation_style} // The person's strategy used to justify proposals: "subjective" emphasize your personal perspective and preferences to persuade others of your proposal. Focus on why you believe this is the best choice based on your values and goals; "contrastive" compare your proposal with the current route. Explain how your proposal is superior by highlighting specific differences, trade-offs, and advantages (e.g., travel time, costs, etc.); "both" combines both 'subjective' and 'contrastive' approaches; "auto" flexibly chooses the most appropriate explanation style ('subjective', 'contrastive', or 'both') based on the current context and what would be most persuasive for the situation.

# Meeting Info
You are joining the following meeting:
- Meeting Title: {meeting_title}
- Meeting Goal: {meeting_goals}
- {num_participants} participants (including you) are joining the meeting.
- Other participant name(s) are as follows: {other_participants}
{meeting_workflow}
{constraints_text}

# Rules
Strictly follow the rules below:
1. **Your Focus is Determing Route:** Focus on determining the route's points of interest, total cost, travel time, and duration of stay at each location. There is no need to consider reservations for the places to be visited. 
2. **Stay in Character:** Always act consistently with the persona above.
3. **Avoid meta-commentary (e.g., "As an AI model..."):** Respond naturally, as if you are actually speaking during the meeting.
4. **Focus on Your Personal Goals:** When you speak, ensure that your comments align with your personal goals. While preserving the meeting goals, continue to pursue your personal goals.
5. **Maintain a Natural Conversational Flow:** Listen carefully to others and respond in a way that follows the flow of the discussion. NEVER ignore what others have said and simply state your own opinion in isolation.\
"""


#---------------------
# Turn Action
#---------------------
_SEARCH_ACTION = "- **search**: Gather accurate information via web search. Use it to verify details such as site information, costs, and travel times and transportation fares. Set the search query in the `query` field of the JSON output.\n"
_PASS_ACTION = "- **pass**: Skip your turn if you have nothing new to add right now.\n"

FREE_CONVERSATION_ACTION_PROMPT = """\
It's your turn to speak. In your turn, you may take up to {max_steps} actions.
The available intermediate actions are as follows:
{search_action}- **ask**: Ask other participants questions to gather their opinions. Set the participant name you want to ask in the `ask_target` field of the JSON output, and write the question itself as your utterance in the `message` field.
- **reflect**: Review the previous discussion and organize your thoughts. Set your monologue summarizing your thoughts in the `message` field.

You must end your turn with one of the following final actions:
- **propose**: Propose a new route. Describe your idea in `message`. The detailed route will be generated from it. After you propose it, it will be evaluated by the other participants during the voting phase, so actively propose it in order to have your new idea tested. If you have specific concerns or ideas about the current route, DO NOT just voice them — propose a concrete alternative route instead.
- **satisfied**: Agree to conclude the meeting. ONLY choose this if you can honestly say the current route addresses your most important personal goals. Before choosing `satisfied`, mentally check: does the route include the specific destinations/experiences I care about most? If key goals are missing, do NOT choose `satisfied` — propose an alternative instead. Do NOT choose `satisfied` just because others have or because you feel the discussion is going in circles.
{pass_block}

IMPORTANT: NEVER include multiple actions in a single step. For example, NEVER propose a route within the "ask" action. Instead, take the appropriate "ask" or "propose" action separately in different steps.

# Current Meeting Status
- Turn Structure: {turn_structure_text}
- Your speaking position: {speaking_position}
{position_guidance}
- Current route: {current_route_text}

# Your Turn Status
- Current Step: {step_number} / {max_steps}
- Your action history of this turn is as follows:
{action_history}

# Output Format
Now, take the next SINGLE action in this turn while setting a natural conversational utterance in the `message` field.
{format_instructions}
"""

class FreeActionStep(BaseModel):
    """One step in the free conversation action loop."""
    action: Literal[
        "search",
        "ask",
        "reflect",
        "propose",
        "satisfied"
    ] = Field(
        description="Select one of the action types"
    )
    message: str = Field(
        description="Your natural conversational utterance. Always speak in character as your persona.",
    )
    query: Optional[str] = Field(
        default=None,
        description="A natural language search query when action is `search`.",
    )
    ask_target: Optional[str] = Field(
        default=None,
        description="The exact name of one of the participants to ask when action is `ask`.",
    )

class FreeActionStepNoSearch(BaseModel):
    """Free conversation step without web search."""
    action: Literal[
        "ask",
        "reflect",
        "propose",
        "satisfied"
    ] = Field(
        description="Select one of the action types"
    )
    message: str = Field(
        description="Your natural conversational utterance. Always speak in character as your persona.",
    )
    ask_target: Optional[str] = Field(
        default=None,
        description="The exact name of one of the participants to ask when action is `ask`.",
    )

class FreeActionStepWithPass(BaseModel):
    """Free conversation step with pass option (volunteer mode)."""
    action: Literal[
        "search",
        "ask",
        "reflect",
        "propose",
        "satisfied",
        "pass"
    ] = Field(
        description="Select one of the action types"
    )
    message: str = Field(
        description="Your natural conversational utterance. Always speak in character as your persona.",
    )
    query: Optional[str] = Field(
        default=None,
        description="A natural language search query when action is 'search'.",
    )
    ask_target: Optional[str] = Field(
        default=None,
        description="The exact name of one of the participants to ask when action is 'ask'.",
    )

class FreeActionStepNoSearchWithPass(BaseModel):
    """Free conversation step without web search, with pass option."""
    action: Literal[
        "ask",
        "reflect",
        "propose",
        "satisfied",
        "pass"
    ] = Field(
        description="Select one of the action types."
    )
    message: str = Field(
        description="Your natural conversational utterance. Always speak in character as your persona.",
    )
    ask_target: Optional[str] = Field(
        default=None,
        description="The exact name of one of the participants to ask when action is 'ask'.",
    )


#----------------
# Route Proposal
#----------------
FREE_PROPOSAL_PROMPT = """\
You have decided to propose a route in your turn. Present the route you determined.

# History of your turn is as follows:
{action_history}

# Output Format
Now, output your proposed route as an ordered list of destinations while setting a natural conversational explanation in the `message` field.
Ensure that the arrival time at each destination is consistent with the arrival time at the previous destination, the duration of stay, and the travel time between locations.
{format_instructions}
"""

# Route drafting on behalf of a human participant: turn their free-text idea
# (and any partial route they have started) into a complete, ordered route.
class Destination(BaseModel):
    name: str = Field(default="", description="Destination name.")
    description: str = Field(default="", description="Short highlight or purpose of the visit.")
    transport_mode: str = Field(default="", description="Transportation mode from the previous stop.")
    transport_cost: str = Field(default="", description="Estimated transport cost per participant from the previous stop to this destination. Format: a currency symbol followed by a number only (e.g., '$5', '¥230'). If free, use '$0' / '¥0'. Never use words or notes (e.g., 'Free', 'included').")
    travel_time_from_previous: str = Field(default="", description="Travel time from the previous stop (e.g., '10 min').")
    start_time: str = Field(default="", description="Planned arrival/start time (e.g., '10:00'). Ensure that ((`start_time` of the previous destination + `stay_duration` of the previous destination) + `travel_time_from_previous` of this destination) does not exceed the `start_time` of this destination.")
    stay_duration: str = Field(default="", description="Expected stay duration (e.g., '60 min').")
    cost: str = Field(default="", description="Estimated cost per participant at this destination. Format: a currency symbol followed by a number only (e.g., '$20', '¥1500'). If free, use '$0' / '¥0'. Never use words or notes (e.g., 'Free entry', 'donation optional').")

class RouteDraft(BaseModel):
    message: str = Field(description="Your message to other participants.")
    route: List[Destination] = Field(default_factory=list, description="The ordered list of destinations to visit.")


#-----
# Q&A
#-----
ASK_RESPONSE_PROMPT = """\
{asker_name} has asked you the following question during {asker_name}'s turn.

# Current accepted route:
{current_route_text}

# Question:
{question}

## Instructions
- Respond naturally, staying in character with your persona.
- Be concise and helpful. Focus on answering the specific question.
- Consider the meeting context and your personal goals.

# Output Format
{format_instructions}
"""

class AskResponse(BaseModel):
    """Response from a participant who was asked a question."""
    message: str = Field(description="Your response to the question.")


#----------
# Inviting
#----------
NEXT_SPEAKER_INVITE_PROMPT = """\
You just finished your speaking turn. Now choose who should speak next.

Available participants who can speak next: {available_candidates_text}

# Instructions
- Pick exactly one name from the available participants and set it in `next_speaker`.
- Think strategically: Who would be most likely to move the discussion forward? Consider inviting someone who might support your ideas, or someone whose perspective hasn't been heard yet.
- In `message`, write a natural conversational handoff addressed directly to the next speaker. Frame it in a way that encourages them to engage with the topic you care about.

# Output Format
{format_instructions}
"""

NEXT_SPEAKER_FACILITATE_PROMPT = """\
As the meeting facilitator, choose who should speak next to ensure a balanced and productive discussion.

Available participants who can speak next: {available_candidates_text}

# Instructions
- Pick exactly one name from the available participants and set it in `next_speaker`.
- Prioritize balance: give voice to participants who haven't spoken much, or whose concerns haven't been addressed.
- Consider the discussion flow: who has relevant expertise or a different perspective that could enrich the conversation?
- In `message`, write a brief facilitation comment that encourages inclusive dialogue.

# Output Format
{format_instructions}
"""

class NextSpeakerDecision(BaseModel):
    next_speaker: str = Field(description="The exact name of one of the participants you choose to speak next.")
    message: str = Field(description="Natural conversational handoff addressed directly to the next speaker.")


#--------
# Voting
#--------
FREE_VOTE_PROMPT = """\
It's your turn to vote for {proposer_name}'s route. In your turn, you may take up to {max_steps} actions.
The available intermediate actions are as follows:
{search_action}- **ask**: Ask other participants questions to gather their opinions. Set the participant name you want to ask in the `ask_target` field of the JSON output, and write the question itself as your utterance in the `message` field.
- **reflect**: Review the previous discussion and organize your thoughts. Set your monologue summarizing your thoughts in the `message` field.

You must end your turn with one of the following final actions:
- **accept**: Accept the proposed route — replace the current route with the proposed one. Only accept if the proposal genuinely serves your personal goals better than (or at least as well as) the current route.
- **reject**: Reject the proposed route — keep the current route. If the proposal neglects your key priorities or introduces trade-offs you find unacceptable, you should reject it and explain why.

Before voting, carefully evaluate: Does this proposal address MY personal goals? What am I gaining and what am I losing compared to the current route? Do not accept out of politeness — vote based on your genuine assessment.

IMPORTANT: NEVER take multiple actions above in a single step. For example, NEVER ask questions within the "reflect" action. Instead, take the "ask" or "reflect" action separately in different steps.

# Voting Rule
{voting_rule_description}

# Current Route
{current_route_text}

# {proposer_name}'s Proposed route
{proposed_route_text}

# Your Turn Status
- Current Step: {step_number} / {max_steps}
- Your action history of this voting turn is as follows:
{action_history}

# Output Format
Now, take the next SINGLE action in this turn while setting a natural conversational utterance in the `message` field.
{format_instructions}
"""

class FreeVoteStep(BaseModel):
    """One step in the voting action loop."""
    action: Literal[
        "search",
        "ask",
        "reflect",
        "accept",
        "reject"
    ] = Field(
        description="Select one of the action types."
    )
    message: str = Field(
        description="Your natural conversational utterance. Always speak in character as your persona.",
    )
    query: Optional[str] = Field(
        default=None,
        description="A natural language search query when action is 'search'.",
    )
    ask_target: Optional[str] = Field(
        default=None,
        description="The exact name of one of the participants to ask when action is 'ask'.",
    )

class FreeVoteStepNoSearch(BaseModel):
    """Voting step without web search."""
    action: Literal[
        "ask",
        "reflect",
        "accept",
        "reject"
    ] = Field(
        description="Select one of the action types."
    )
    message: str = Field(
        description="Your natural conversational utterance. Always speak in character as your persona.",
    )
    ask_target: Optional[str] = Field(
        default=None,
        description="The exact name of one of the participants to ask when action is 'ask'.",
    )

FREE_SCORE_PROMPT = """\
It's your turn to score {proposer_name}'s route. In your turn, you may take up to {max_steps} actions.
The available intermediate actions are as follows:
{search_action}- **ask**: Ask other participants questions to gather their opinions. Set the participant name you want to ask in the `ask_target` field of the JSON output, and write the question itself as your utterance in the `message` field.
- **reflect**: Review the previous discussion and organize your thoughts. Set your monologue summarizing your thoughts in the `message` field.

You must end your turn with the following final action:
- **scoring**: Give a final score from 1 to 10 in the `score` field.

# Voting Rule
{voting_rule_description}

# Current Route
{current_route_text}
{current_route_score}

# {proposer_name}'s Proposed route
{proposed_route_text}

# Your Turn Status
- Current Step: {step_number} / {max_steps}
- Your action history of this voting turn is as follows:
{action_history}

# Output Format
Now, take the next action in this turn while setting a natural conversational utterance in the `message` field.
{format_instructions}
"""

class FreeScoreStep(BaseModel):
    """One step in the scoring action loop."""
    action: Literal[
        "search",
        "ask",
        "reflect",
        "scoring",
    ] = Field(
        description="Select one of the action types."
    )
    message: str = Field(
        description="Your natural conversational utterance. Always speak in character as your persona.",
    )
    query: Optional[str] = Field(
        default=None,
        description="A natural language search query when action is 'search'.",
    )
    ask_target: Optional[str] = Field(
        default=None,
        description="The exact name of one of the participants to ask when action is 'ask'.",
    )
    score: Optional[int] = Field(
        default=None,
        description=(
            "The score from 1 to 10 when action is 'scoring'. Use this exact rubric:\n"
            "10 - Perfect: All destinations, transportation methods, costs, and timing are perfectly aligned with my preferences; I would not change anything and no better route could reasonably exist for me.\n"
            "9 - Near-Perfect (Minor Refinement Possible): All aspects are almost perfectly aligned with my preferences; only one or two minor adjustments could further improve the route.\n"
            "8 - Very Strong (Several Small Improvements Possible): Overall highly satisfying; most elements fit my preferences well, but multiple small refinements would improve the experience.\n"
            "7 - Strong but Noticeable Trade-offs: Generally satisfying, but there are clear trade-offs in two or more aspects (e.g., timing slightly tight, cost slightly high, or one destination less appealing).\n"
            "6 - Moderately Positive: The route meets my preferences in several areas, but there are noticeable weaknesses that reduce overall satisfaction.\n"
            "5 - Neutral: The route is acceptable but unremarkable; it neither strongly satisfies nor significantly conflicts with my preferences, and several meaningful improvements are needed to make it clearly appealing.\n"
            "4 - Somewhat Unsatisfactory: Multiple aspects do not align well with my preferences, and I would recommend significant revisions.\n"
            "3 - Weak Fit: The route conflicts with my preferences in several major aspects (destinations, timing, cost, or transport), and major restructuring is required.\n"
            "2 - Poor Fit: Most elements are misaligned with my preferences; only a few aspects are acceptable.\n"
            "1 - Completely Unsatisfactory: The route fails to meet my preferences across nearly all dimensions and would need to be entirely redesigned."
        ),
    )


class FreeScoreStepNoSearch(BaseModel):
    """Scoring step without web search."""
    action: Literal[
        "ask",
        "reflect",
        "scoring",
    ] = Field(
        description="Select one of the action types."
    )
    message: str = Field(
        description="Your natural conversational utterance. Always speak in character as your persona.",
    )
    ask_target: Optional[str] = Field(
        default=None,
        description="The exact name of one of the participants to ask when action is 'ask'.",
    )
    score: Optional[int] = Field(
        default=None,
        description=(
            "The score from 1 to 10 when action is 'scoring'. Use this exact rubric:\n"
            "10 - Perfect: All destinations, transportation methods, costs, and timing are perfectly aligned with my preferences; I would not change anything and no better route could reasonably exist for me.\n"
            "9 - Near-Perfect (Minor Refinement Possible): All aspects are almost perfectly aligned with my preferences; only one or two minor adjustments could further improve the route.\n"
            "8 - Very Strong (Several Small Improvements Possible): Overall highly satisfying; most elements fit my preferences well, but multiple small refinements would improve the experience.\n"
            "7 - Strong but Noticeable Trade-offs: Generally satisfying, but there are clear trade-offs in two or more aspects (e.g., timing slightly tight, cost slightly high, or one destination less appealing).\n"
            "6 - Moderately Positive: The route meets my preferences in several areas, but there are noticeable weaknesses that reduce overall satisfaction.\n"
            "5 - Neutral: The route is acceptable but unremarkable; it neither strongly satisfies nor significantly conflicts with my preferences, and several meaningful improvements are needed to make it clearly appealing.\n"
            "4 - Somewhat Unsatisfactory: Multiple aspects do not align well with my preferences, and I would recommend significant revisions.\n"
            "3 - Weak Fit: The route conflicts with my preferences in several major aspects (destinations, timing, cost, or transport), and major restructuring is required.\n"
            "2 - Poor Fit: Most elements are misaligned with my preferences; only a few aspects are acceptable.\n"
            "1 - Completely Unsatisfactory: The route fails to meet my preferences across nearly all dimensions and would need to be entirely redesigned."
        ),
    )


#---------------------------
# Post-consensus evaluation
#---------------------------
POST_CONSENSUS_EVAL_PROMPT = """\
The meeting has concluded and the group has agreed on the following final route.
As {name}, evaluate how well this route satisfies YOUR personal goals.

# Your Personal Goals
{personal_goals}

# Final Agreed Route
{final_route_text}

# Instructions
- Score the route from 1 to 10 based ONLY on how well it serves your personal goals.
- In `reason`, briefly explain what goals are met and what is missing or compromised.
- Be honest. Do not inflate your score out of politeness. If key goals are unmet, score low.

# Output Format
{format_instructions}
"""

class PostConsensusEval(BaseModel):
    """Post-meeting satisfaction evaluation."""
    score: int = Field(
        description=(
            "Score from 1 to 10. "
            "10 = all my personal goals are perfectly met. "
            "7 = most goals met with some trade-offs. "
            "5 = acceptable but several goals unmet. "
            "3 = major goals unmet. "
            "1 = route completely ignores my goals."
        ),
    )
    reason: str = Field(
        description="Brief explanation of which goals are met and which are compromised.",
    )


#------------------
# Context management
#------------------
class HistorySummary(BaseModel):
    """Summarized meeting history."""
    summary: str = Field(description="A concise summary of the meeting discussion, preserving key decisions, proposals, votes, route details, and important points with participant names.")


#------------------
# agent definition
#------------------
MessageDeltaCallback = Callable[[str, Dict[str, Any]], Awaitable[None]]


class Participant:
    def __init__(
        self,
        llm,
        name: str,
        background: str,
        personality: str,
        preferences: str,
        personal_goals: str,
        role: Literal["facilitator", "attendee"] = "attendee",
        speaking_style: str = "friendly",
        explanation_style: Literal["auto", "subjective", "contrastive", "both"] = "auto",
        max_retries: int = 3,
        retry_delay: float = 1.0,
        web_search: bool = True,
        max_steps: int = 5,
        context_mode: str = "auto_compact",
        auto_compact_threshold: float = 0.8,
        auto_compact_target: float = 0.5,
        fixed_turns_count: int = 10,
        compact_recent_ratio: float = 0.7,
        system_prompt: Optional[str] = None,
    ) -> None:
        self.llm = llm
        self.name = name
        self.background = background
        self.personality = personality
        self.preferences = preferences
        self.personal_goals = personal_goals
        self.role = role
        self.speaking_style = speaking_style
        self.explanation_style = explanation_style
        # Optional full override of the participant system prompt.  When set to a
        # non-empty string it entirely replaces SYS_PARTICIPANT for every LLM
        # call (turn, vote, answer, next-speaker).  The template is rendered with
        # the same placeholders as SYS_PARTICIPANT ({name}, {role}, {background},
        # {personality}, {preferences}, {personal_goals}, {speaking_style},
        # {explanation_style}, {meeting_title}, {meeting_goals}, {meeting_workflow},
        # {num_participants}, {other_participants}, {constraints_text}); via
        # safe_format, any unused/unknown braces are kept literal.  Operational
        # instructions (action loop, JSON output format, voting rules) live in
        # the per-task human prompts and are unaffected.
        self.system_prompt: Optional[str] = system_prompt
        self.system_prompt_template: str = (
            system_prompt if (system_prompt and system_prompt.strip()) else SYS_PARTICIPANT
        )
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.web_search = web_search
        self.max_steps = max_steps
        self.context_mode = context_mode
        self.auto_compact_threshold = auto_compact_threshold
        self.auto_compact_target = auto_compact_target
        self.fixed_turns_count = fixed_turns_count
        self.compact_recent_ratio = compact_recent_ratio
        self._compact_cache_older_count: int = 0  # Number of messages summarized in cache
        self._compact_cache_summary: Optional[str] = None  # Cached summary text
        self.meeting_title: str = ""  # Set by tour_meeting.py before meeting starts
        self.constraints_text: str = ""  # Set by tour_meeting.py before meeting starts
        # Structured time window ("HH:MM" or None), set by tour_meeting.py;
        # used to validate proposed routes mechanically (with retry feedback).
        self.time_window_start: Optional[str] = None
        self.time_window_end: Optional[str] = None
        self.meeting_workflow: str = ""  # Set by tour_meeting.py before meeting starts
        self.last_token_usage: Optional[Dict[str, int]] = None  # Track token usage from last turn (input/output/total)
        self.last_llm_calls: List[Dict[str, Any]] = []  # Per-step LLM call records for context size tracking
        self.last_compaction_event: Optional[Dict[str, int]] = None  # {tokens_before, tokens_after}

    def reset_context_cache(self) -> None:
        """Clear cached summary state used by auto_compact context management."""
        self._compact_cache_older_count = 0
        self._compact_cache_summary = None

    @staticmethod
    def _extract_meeting_goal(history: List[HumanMessage | AIMessage]) -> str:
        for msg in history or []:
            if getattr(msg, "name", "") == "MeetingGoal":
                return msg.content
        return ""

    @staticmethod
    def _voting_rule_description(voting_rule: str) -> str:
        if voting_rule == "majority":
            return (
                "Majority voting: each voter chooses accept/reject. "
                "For the decision threshold, the proposer is counted as one accept vote. "
                "The proposal is accepted only if accepts are a strict majority of considered votes."
            )
        if voting_rule == "unanimous":
            return (
                "Unanimous voting: each voter chooses accept/reject. "
                "For the decision threshold, the proposer is counted as one accept vote. "
                "The proposal is accepted only if all considered votes are accept."
            )
        if voting_rule == "single_decider":
            return (
                "Single decider: one designated decider's accept/reject determines the result."
            )
        if voting_rule == "most_pleasure":
            return (
                "Most Pleasure (score-based): each voter gives 1-10 points. "
                "Compute the proposal representative score as the SUM of voter scores; "
                "the proposal is accepted only if this sum is equal to or greater than the current route's representative score."
            )
        if voting_rule == "least_misery":
            return (
                "Least Misery (score-based): each voter gives 1-10 points. "
                "Compute the proposal representative score as the MINIMUM voter score; "
                "the proposal is accepted only if this minimum is equal to or greater than the current route's representative score."
            )
        return (
            f"{voting_rule}: follow the configured voting rule in this meeting when deciding whether to accept or reject."
        )

    @staticmethod
    def _is_non_empty_text(value: Any) -> bool:
        return isinstance(value, str) and value.strip() != ""

    @classmethod
    def _validate_action_required_fields(
        cls,
        result: Dict[str, Any],
        *,
        mode: Literal["vote", "free_turn"],
        allow_search: bool,
        is_score_mode: bool = False,
    ) -> None:
        action = result.get("action")
        if not isinstance(action, str) or action.strip() == "":
            raise ValueError("`action` is required and must be a non-empty string.")

        if action == "search":
            if not allow_search:
                raise ValueError("`search` action is not allowed in this turn.")
            if not cls._is_non_empty_text(result.get("query")):
                raise ValueError("`query` is required when action is `search`.")

        if action == "ask":
            if not cls._is_non_empty_text(result.get("ask_target")):
                raise ValueError("`ask_target` is required when action is `ask`.")

        if mode == "vote" and is_score_mode and action == "scoring":
            score = result.get("score")
            if not isinstance(score, (int, float)) or isinstance(score, bool):
                raise ValueError("`score` is required and must be a number when action is `scoring`.")

    @staticmethod
    def _format_route(route: Optional[List[Any]]) -> str:
        if not route:
            return ""
        names: List[str] = []
        for item in route:
            if isinstance(item, str):
                if item:
                    names.append(item)
            else:
                name = getattr(item, "name", None)
                if name:
                    names.append(name)
        return " -> ".join(names)

    @staticmethod
    def format_route_draft_text(draft: RouteDraft) -> str:
        return draft.message or ""

    @staticmethod
    def _sanitize_route_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
        route_entries = payload.get("route")
        if isinstance(route_entries, list):
            normalized = []
            for entry in route_entries:
                if isinstance(entry, dict):
                    normalized.append(
                        {
                            "name": str(entry.get("name") or ""),
                            "description": str(entry.get("description") or ""),
                            "start_time": str(entry.get("start_time") or ""),
                            "stay_duration": str(entry.get("stay_duration") or ""),
                            "travel_time_from_previous": str(entry.get("travel_time_from_previous") or ""),
                            "transport_mode": str(entry.get("transport_mode") or ""),
                            "cost": str(entry.get("cost") or ""),
                            "transport_cost": str(entry.get("transport_cost") or ""),
                        }
                    )
                else:
                    normalized.append(
                        {
                            "name": str(getattr(entry, "name", "") or ""),
                            "description": str(getattr(entry, "description", "") or ""),
                            "start_time": str(getattr(entry, "start_time", "") or ""),
                            "stay_duration": str(getattr(entry, "stay_duration", "") or ""),
                            "travel_time_from_previous": str(getattr(entry, "travel_time_from_previous", "") or ""),
                            "transport_mode": str(getattr(entry, "transport_mode", "") or ""),
                            "cost": str(getattr(entry, "cost", "") or ""),
                            "transport_cost": str(getattr(entry, "transport_cost", "") or ""),
                        }
                    )
            payload = dict(payload)
            payload["route"] = normalized
        return payload
    
    def _to_first_person_history(
        self, history: List[HumanMessage | AIMessage]
    ) -> List[HumanMessage | AIMessage]:
        """Re-role history so only *this* participant's messages are ``assistant``.

        Other participants' ``AIMessage`` entries are converted to
        ``HumanMessage`` with ``[Name]: …`` prefix so the LLM sees a clear
        distinction between its own prior utterances and other speakers.
        """
        out: List[HumanMessage | AIMessage] = []
        # Inline sanitize to match names stored by tour_meeting.sanitize_name()
        my_name = re.sub(r'[\s\u3000<|\\/>\n\r\t]+', '_', self.name or '').strip('_') or 'anon'
        for msg in history:
            if isinstance(msg, AIMessage) and msg.name:
                speaker = msg.name
                content = msg.content
                if isinstance(content, list):
                    parts = []
                    for chunk in content:
                        if isinstance(chunk, dict):
                            parts.append(str(chunk.get("text") or ""))
                        else:
                            parts.append(str(chunk))
                    content = " ".join(parts)
                if speaker == my_name:
                    # Own message: keep as AIMessage (assistant role) with (you) label
                    out.append(AIMessage(
                        content=f"[{speaker} (you)]: {content}",
                        name=msg.name,
                        additional_kwargs=msg.additional_kwargs,
                    ))
                else:
                    # Other participant: convert to HumanMessage (user role)
                    out.append(HumanMessage(
                        content=f"[{speaker}]: {content}",
                        name=msg.name,
                    ))
            else:
                out.append(msg)
        return out

    # ------------------------------------------------------------------
    # Context management
    # ------------------------------------------------------------------

    def _estimate_tokens(self, history: List[HumanMessage | AIMessage]) -> int:
        """Estimate token count of history messages using tiktoken."""
        total = 0
        for msg in history:
            content = msg.content if isinstance(msg.content, str) else str(msg.content)
            total += len(_tiktoken_enc.encode(content))
        return total

    async def _apply_context_management(
        self, history: List[HumanMessage | AIMessage]
    ) -> List[HumanMessage | AIMessage]:
        """Apply context management strategy to a history copy before LLM call."""
        if not history:
            return history

        max_ctx = getattr(self.llm, "max_context_length", None)

        # fixed_turns: always apply regardless of max_context_length
        if self.context_mode == "fixed_turns":
            return self._apply_fixed_turns(history)

        # truncate / auto_compact: need max_context_length
        if max_ctx is None or max_ctx <= 0:
            return history

        threshold = int(max_ctx * self.auto_compact_threshold)
        target = int(max_ctx * self.auto_compact_target)

        if self.context_mode == "auto_compact":
            # auto_compact manages its own threshold check against the compacted view
            return await self._apply_auto_compact(history, threshold, target)

        # truncate: check against raw history
        estimated = self._estimate_tokens(history)
        if estimated <= threshold:
            return history
        return self._apply_truncate(history, target, estimated)

    def _apply_fixed_turns(
        self, history: List[HumanMessage | AIMessage]
    ) -> List[HumanMessage | AIMessage]:
        """Keep last N messages."""
        n = self.fixed_turns_count
        trimmed = history[-n:] if len(history) > n else list(history)
        if len(history) > n:
            logger.info(
                "[ContextMgmt] %s: fixed_turns=%d, kept %d/%d messages",
                self.name, n, len(trimmed), len(history),
            )
        return trimmed

    def _apply_truncate(
        self,
        history: List[HumanMessage | AIMessage],
        target_tokens: int,
        original_tokens: int,
    ) -> List[HumanMessage | AIMessage]:
        """Remove oldest messages until under target tokens."""
        rest = list(history)
        original_count = len(rest)

        while rest and self._estimate_tokens(rest) > target_tokens:
            rest.pop(0)

        result = rest
        removed = original_count - len(rest)
        if removed > 0:
            new_tokens = self._estimate_tokens(result)
            logger.info(
                "[ContextMgmt] %s: truncate removed %d messages, tokens %d -> %d (target=%d)",
                self.name, removed, original_tokens, new_tokens, target_tokens,
            )
        return result

    async def _apply_auto_compact(
        self,
        history: List[HumanMessage | AIMessage],
        threshold_tokens: int,
        target_tokens: int,
    ) -> List[HumanMessage | AIMessage]:
        """Incrementally summarize history with compacted-view threshold check.

        Flow:
        1. If cache exists → build compacted view (Summary + tail)
           - If compacted view <= threshold → return as-is (no LLM call)
           - If compacted view > threshold → incrementally extend summary
        2. If no cache → check raw history, summarize if over threshold
        """
        rest = list(history)

        if len(rest) <= 2:
            return history

        # --- Case 1: Cache exists → build compacted view ---
        if self._compact_cache_summary is not None:
            split = self._compact_cache_older_count
            # History may reset between runs; discard stale cache pointers.
            if split <= 0 or split >= len(rest):
                self.reset_context_cache()
            else:
                summary_msg = HumanMessage(
                    content=f"[Meeting History Summary]\n{self._compact_cache_summary}",
                    name="HistorySummary",
                )
                tail = list(rest[split:])
                compacted = [summary_msg] + tail
                compacted_tokens = self._estimate_tokens(compacted)

                if compacted_tokens <= threshold_tokens:
                    # Under threshold → return compacted view, no LLM call
                    return compacted

                # Over threshold → extend summary incrementally
                # Find new recent portion within the tail
                recent: List[HumanMessage | AIMessage] = []
                recent_budget = int(target_tokens * self.compact_recent_ratio)
                for msg in reversed(tail):
                    candidate = [msg] + recent
                    if self._estimate_tokens(candidate) > recent_budget:
                        break
                    recent.insert(0, msg)

                new_older = tail[: len(tail) - len(recent)]
                if not new_older:
                    return compacted

                logger.info(
                    "[ContextMgmt] %s: auto_compact extending summary with %d new messages (compacted tokens=%d, threshold=%d)",
                    self.name, len(new_older), compacted_tokens, threshold_tokens,
                )
                summary_budget = target_tokens - recent_budget
                summary_text = await self._summarize_history_incremental(
                    self._compact_cache_summary, new_older, summary_budget
                )
                self._compact_cache_older_count = split + len(new_older)
                self._compact_cache_summary = summary_text

                new_summary_msg = HumanMessage(
                    content=f"[Meeting History Summary]\n{summary_text}",
                    name="HistorySummary",
                )
                result = [new_summary_msg] + recent
                result_tokens = self._estimate_tokens(result)
                logger.info(
                    "[ContextMgmt] %s: auto_compact done, tokens %d -> %d",
                    self.name, compacted_tokens, result_tokens,
                )
                self.last_compaction_event = {"tokens_before": compacted_tokens, "tokens_after": result_tokens}
                return result

        # --- Case 2: No cache → check raw history ---
        raw_tokens = self._estimate_tokens(history)
        if raw_tokens <= threshold_tokens:
            return history

        # First-time summarization
        recent: List[HumanMessage | AIMessage] = []
        recent_budget = int(target_tokens * self.compact_recent_ratio)
        for msg in reversed(rest):
            candidate = [msg] + recent
            if self._estimate_tokens(candidate) > recent_budget:
                break
            recent.insert(0, msg)

        older = rest[: len(rest) - len(recent)]
        if not older:
            return history

        logger.info(
            "[ContextMgmt] %s: auto_compact initial summarization of %d messages, keeping %d recent (tokens=%d, target=%d)",
            self.name, len(older), len(recent), raw_tokens, target_tokens,
        )
        summary_budget = target_tokens - recent_budget
        summary_text = await self._summarize_history(older, summary_budget)
        self._compact_cache_older_count = len(older)
        self._compact_cache_summary = summary_text

        summary_msg = HumanMessage(
            content=f"[Meeting History Summary]\n{summary_text}",
            name="HistorySummary",
        )
        result = [summary_msg] + recent
        result_tokens = self._estimate_tokens(result)
        logger.info(
            "[ContextMgmt] %s: auto_compact done, tokens %d -> %d",
            self.name, raw_tokens, result_tokens,
        )
        self.last_compaction_event = {"tokens_before": raw_tokens, "tokens_after": result_tokens}
        return result

    async def _summarize_history(
        self, messages: List[HumanMessage | AIMessage], summary_budget: int
    ) -> str:
        """Use LLM to summarize older history messages within a token budget."""
        lines = []
        for msg in messages:
            content = msg.content if isinstance(msg.content, str) else str(msg.content)
            name = getattr(msg, "name", "Unknown")
            lines.append(f"[{name}]: {content}")
        text = "\n\n".join(lines)

        format_instr = get_format_instructions(HistorySummary)

        async def _op(error_context: List[Dict[str, str]]):
            prompt = (
                "Summarize the following meeting discussion concisely. "
                "Preserve key decisions, proposals, votes, route details, and important points. "
                "Keep participant names and their positions.\n\n"
                f"IMPORTANT: Keep the summary within {summary_budget} tokens.\n\n"
                f"{text}\n\n{format_instr}"
            )
            msgs: list = [{"role": "user", "content": prompt}]
            if error_context:
                msgs.extend(error_context)

            llm_kwargs = build_litellm_kwargs(self.llm)
            response = await litellm.acompletion(messages=msgs, **llm_kwargs)

            tracker = TokenTracker(self.name)
            tracker.record_usage(response)
            raw = response.choices[0].message.content or ""
            tracker.record_content(raw)
            finish_reason = getattr(response.choices[0], "finish_reason", None)

            try:
                parsed = extract_json(raw)
            except (ValueError, _json.JSONDecodeError) as exc:
                if finish_reason == "length":
                    raise LLMParseError(
                        f"Output truncated by max_tokens (budget: {summary_budget} tokens). "
                        "Produce a shorter summary that fits within the budget.",
                        raw_output=raw,
                    ) from exc
                raise LLMParseError(str(exc), raw_output=raw) from exc

            summary = parsed.get("summary", raw)
            actual_tokens = len(_tiktoken_enc.encode(summary))
            if actual_tokens > summary_budget:
                raise LLMParseError(
                    f"Summary too long: {actual_tokens} tokens (budget: {summary_budget}). "
                    "Please produce a shorter summary.",
                    raw_output=raw,
                )
            return summary, tracker

        return await self._retry_with_backoff(
            "Summarize history", _op,
            format_instructions=format_instr,
        )

    async def _summarize_history_incremental(
        self, previous_summary: str, new_messages: List[HumanMessage | AIMessage],
        summary_budget: int,
    ) -> str:
        """Update an existing summary with new messages within a token budget."""
        lines = []
        for msg in new_messages:
            content = msg.content if isinstance(msg.content, str) else str(msg.content)
            name = getattr(msg, "name", "Unknown")
            lines.append(f"[{name}]: {content}")
        new_text = "\n\n".join(lines)

        format_instr = get_format_instructions(HistorySummary)

        async def _op(error_context: List[Dict[str, str]]):
            prompt = (
                "You have a summary of an earlier part of a meeting discussion. "
                "New messages have since been added. Update the summary to incorporate "
                "the new information. Preserve key decisions, proposals, votes, route details, "
                "and important points. Keep participant names and their positions.\n\n"
                f"IMPORTANT: Keep the updated summary within {summary_budget} tokens.\n\n"
                f"Previous summary:\n{previous_summary}\n\n"
                f"New messages:\n{new_text}\n\n"
                f"{format_instr}"
            )
            msgs: list = [{"role": "user", "content": prompt}]
            if error_context:
                msgs.extend(error_context)

            llm_kwargs = build_litellm_kwargs(self.llm)
            response = await litellm.acompletion(messages=msgs, **llm_kwargs)

            tracker = TokenTracker(self.name)
            tracker.record_usage(response)
            raw = response.choices[0].message.content or ""
            tracker.record_content(raw)
            finish_reason = getattr(response.choices[0], "finish_reason", None)

            try:
                parsed = extract_json(raw)
            except (ValueError, _json.JSONDecodeError) as exc:
                if finish_reason == "length":
                    raise LLMParseError(
                        f"Output truncated by max_tokens (budget: {summary_budget} tokens). "
                        "Produce a shorter summary that fits within the budget.",
                        raw_output=raw,
                    ) from exc
                raise LLMParseError(str(exc), raw_output=raw) from exc

            summary = parsed.get("summary", raw)
            actual_tokens = len(_tiktoken_enc.encode(summary))
            if actual_tokens > summary_budget:
                raise LLMParseError(
                    f"Summary too long: {actual_tokens} tokens (budget: {summary_budget}). "
                    "Please produce a shorter summary.",
                    raw_output=raw,
                )
            return summary, tracker

        return await self._retry_with_backoff(
            "Summarize history incremental", _op,
            format_instructions=format_instr,
        )

    @staticmethod
    def _truncate_text(text: str, max_len: int = 1500) -> str:
        text = (text or "").strip()
        if len(text) <= max_len:
            return text
        return text[: max_len - 3].rstrip() + "..."

    @staticmethod
    def _format_research_block(notes: Optional[str]) -> str:
        cleaned = (notes or "").strip()
        if not cleaned:
            return ""
        return f"## Internal Planning Notes\n{cleaned}\n"

    def _get_field_names(self, pydantic_class: type) -> List[str]:
        return list(pydantic_class.model_fields.keys())

    @staticmethod
    def _build_research_log(entries: List[Dict[str, Any]], final_summary: str) -> str:
        lines: List[str] = []
        for entry in entries:
            lines.append(
                f"Step {entry.get('step')}: {entry.get('message', entry.get('thought', ''))} (action={entry.get('action')})"
            )
            if entry.get("query"):
                lines.append(f"  Query: {entry['query']}")
            if entry.get("ask_target"):
                lines.append(f"  Ask: {entry['ask_target']}")
            if entry.get("ask_response"):
                lines.append(f"  AskA: {entry['ask_response']}")
            if entry.get("observation"):
                lines.append(f"  Observation: {entry['observation']}")
            lines.append("")
        if final_summary and lines and not str(lines[-1]).startswith("Final takeaway"):
            lines.append(f"Final takeaway: {final_summary}")
        log_text = "\n".join(str(line) for line in lines).strip()
        return Participant._truncate_text(log_text, 2500)

    @staticmethod
    def _gpt5_search_sync(query: str, max_results: int = 3, messages: Optional[List[Dict[str, str]]] = None) -> str:
        return gpt5_search_sync(query, max_results=max_results, messages=messages)

    async def _gpt5_search(self, query: str, max_results: int = 3, messages: Optional[List[Dict[str, str]]] = None) -> str:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None, lambda: self._gpt5_search_sync(query, max_results, messages)
        )

    def _participant_context(
        self,
        other_participant_names: List[str],
        history: List[HumanMessage | AIMessage],
        **extra: Any
    ) -> Dict[str, Any]:
        context = {
            "history": history or [],
            "name": self.name,
            "background": self.background,
            "personality": self.personality,
            "preferences": self.preferences,
            "personal_goals": self.personal_goals,
            "role": self.role,
            "speaking_style": self.speaking_style,
            "explanation_style": self.explanation_style,
            "num_participants": len(other_participant_names) + 1,
            "other_participants": ", ".join(other_participant_names) if other_participant_names else "none",
            "meeting_title": self.meeting_title,
            "constraints_text": self.constraints_text,
            "meeting_workflow": self.meeting_workflow,
            "research_context_block": "",
        }
        context.update(extra)
        # Ensure meeting_goals is available for SYS_PARTICIPANT
        if "meeting_goals" not in context and "meeting_goal" in context:
            context["meeting_goals"] = context["meeting_goal"]
        return context

    async def _call_llm_streaming(
        self,
        pydantic_class: type,
        human_prompt: str,
        payload: dict,
        history: list,
        progress_callback: Optional[MessageDeltaCallback] = None,
        sanitize_route: bool = False,
        error_context: Optional[List[Dict[str, str]]] = None,
    ) -> dict:
        """Call litellm with streaming, parse JSON, and emit progress deltas.

        Raises LLMParseError (with raw_output) if JSON parsing fails.
        """
        field_names = self._get_field_names(pydantic_class)
        format_instr = get_format_instructions(pydantic_class)
        messages = build_messages(
            system_template=self.system_prompt_template,
            history=history,
            payload=payload,
            format_instructions=format_instr,
            human_template=human_prompt,
        )
        if error_context:
            messages.extend(error_context)
        llm_kwargs = build_litellm_kwargs(self.llm)
        response = await litellm.acompletion(messages=messages, stream=True, **llm_kwargs)

        accumulated = ""
        chunks_for_usage: list = []
        prev_message = ""
        result: Optional[Dict[str, Any]] = None

        async for chunk in response:
            chunks_for_usage.append(chunk)
            delta_content = chunk.choices[0].delta.content or ""
            accumulated += delta_content

            try:
                parsed = extract_json(accumulated)
                filtered = {key: parsed.get(key) for key in field_names}
                if sanitize_route:
                    filtered = Participant._sanitize_route_payload(filtered)
                result = filtered

                if progress_callback:
                    message = filtered.get("message") or ""
                    if isinstance(message, dict):
                        message = str(message)
                    if message and message != prev_message:
                        delta = message[len(prev_message):] if message.startswith(prev_message) else message
                        if delta:
                            await progress_callback(delta, filtered)
                        prev_message = message
            except (ValueError, _json.JSONDecodeError):
                continue

        # Build token tracker from streaming chunks
        tracker = TokenTracker(self.name)
        tracker.record_streaming_usage(chunks_for_usage)
        tracker.record_content(accumulated)

        if result is None:
            raise LLMParseError(
                f"Failed to parse JSON from LLM output for {self.name}",
                raw_output=accumulated,
            )

        return result, tracker

    async def _call_llm_invoke(
        self,
        pydantic_class: type,
        human_prompt: str,
        payload: dict,
        history: list,
        error_context: Optional[List[Dict[str, str]]] = None,
    ) -> tuple:
        """Call litellm without streaming, parse JSON, return result and tracker.

        Raises LLMParseError (with raw_output) if JSON parsing fails.
        """
        field_names = self._get_field_names(pydantic_class)
        format_instr = get_format_instructions(pydantic_class)
        messages = build_messages(
            system_template=self.system_prompt_template,
            history=history,
            payload=payload,
            format_instructions=format_instr,
            human_template=human_prompt,
        )
        if error_context:
            messages.extend(error_context)
        llm_kwargs = build_litellm_kwargs(self.llm)
        response = await litellm.acompletion(messages=messages, **llm_kwargs)

        tracker = TokenTracker(self.name)
        tracker.record_usage(response)
        content = response.choices[0].message.content or ""
        tracker.record_content(content)

        try:
            parsed = extract_json(content)
        except (ValueError, _json.JSONDecodeError) as exc:
            raise LLMParseError(str(exc), raw_output=content) from exc
        result = {key: parsed.get(key) for key in field_names}
        return result, tracker

    async def _retry_with_backoff(
        self,
        operation_name: str,
        operation_func: Callable,
        additional_token_usage: Optional[Dict[str, int]] = None,
        retry_callback: Optional[Callable[[int, int, str], Awaitable[None]]] = None,
        format_instructions: str = "",
    ) -> Any:
        """Retry an operation with exponential backoff and error feedback.

        On each failure, if the exception carries a ``raw_output`` attribute
        (e.g. ``LLMParseError``), the failed output and the parse error are
        appended to an ``error_context`` list that is passed to
        ``operation_func`` on the next attempt.  This lets the LLM see its
        previous mistakes and correct them.

        ``operation_func`` signature: ``async (error_context) -> (result, TokenTracker)``
        """
        last_exception = None
        error_context: List[Dict[str, str]] = []
        retry_causes: List[str] = []

        for attempt in range(self.max_retries):
            try:
                _t0 = time.monotonic()
                result, tracker = await operation_func(error_context)
                _latency = time.monotonic() - _t0

                # Update token usage (including additional tokens if provided)
                input_tokens = tracker.token_usage.input_tokens
                output_tokens = tracker.token_usage.output_tokens
                cached_tokens = tracker.token_usage.cached_tokens
                total_tokens = tracker.token_usage.total_tokens

                if additional_token_usage:
                    input_tokens += additional_token_usage.get("input", 0)
                    output_tokens += additional_token_usage.get("output", 0)
                    cached_tokens += additional_token_usage.get("cached", 0)
                    total_tokens += additional_token_usage.get("total", 0)

                self.last_token_usage = {
                    "input": input_tokens,
                    "output": output_tokens,
                    "cached": cached_tokens,
                    "total": total_tokens
                }
                entry = {
                    "step": 1,
                    "call_type": operation_name,
                    "prompt_tokens": tracker.token_usage.input_tokens,
                    "completion_tokens": tracker.token_usage.output_tokens,
                    "retries": attempt,
                    "retry_causes": list(retry_causes),
                    "latency_s": round(_latency, 3),
                }
                route_obj = getattr(result, "route", None)
                if route_obj is not None:
                    try:
                        entry["route_names"] = [
                            getattr(dest, "name", "") for dest in route_obj
                        ]
                        times_ok = True
                        for j, dest in enumerate(route_obj):
                            if _parse_time_to_minutes(getattr(dest, "start_time", "")) is None:
                                times_ok = False
                            if _parse_duration_minutes(getattr(dest, "stay_duration", "")) is None:
                                times_ok = False
                            if j >= 1 and _parse_duration_minutes(
                                getattr(dest, "travel_time_from_previous", "")
                            ) is None:
                                times_ok = False
                        entry["route_times_parseable"] = times_ok
                    except Exception:  # pragma: no cover - defensive
                        pass
                self.last_llm_calls = [entry]
                return result
            except Exception as exc:
                last_exception = exc
                if isinstance(exc, (RouteTimeViolation, RouteCostViolation)):
                    retry_causes.append("constraint")
                elif getattr(exc, "raw_output", ""):
                    retry_causes.append("json")
                else:
                    retry_causes.append("other")
                # Build error feedback for next attempt
                raw_output = _truncate_for_retry_context(getattr(exc, "raw_output", ""))
                if raw_output:
                    error_context.append({"role": "assistant", "content": raw_output})
                    if isinstance(exc, RouteTimeViolation):
                        feedback = (
                            f"Your proposed route has timing errors:\n{exc}\n"
                            "Please regenerate the route with corrected start_time values."
                        )
                    elif isinstance(exc, RouteCostViolation):
                        feedback = (
                            f"Your proposed route has invalid cost values:\n{exc}\n"
                            "Please regenerate the route with corrected cost and "
                            "transport_cost values (currency symbol + number only)."
                        )
                    else:
                        feedback = (
                            f"Your output could not be parsed. Error: {exc}\n"
                            "Please output valid JSON matching the required schema."
                        )
                    if format_instructions:
                        feedback += f"\n\n{format_instructions}"
                    error_context.append({"role": "user", "content": feedback})
                if attempt < self.max_retries - 1:
                    wait_time = self.retry_delay * (2 ** attempt)
                    error_msg = str(exc)
                    logger.warning(
                        f"{operation_name} failed for {self.name} (attempt {attempt + 1}/{self.max_retries}): {error_msg}. "
                        f"Retrying in {wait_time}s..."
                    )
                    if retry_callback:
                        await retry_callback(attempt + 1, self.max_retries, error_msg)
                    await asyncio.sleep(wait_time)
                else:
                    logger.error(
                        f"{operation_name} failed for {self.name} after {self.max_retries} attempts: {exc}"
                    )

        raise last_exception or RuntimeError(f"{operation_name} failed after all retries")

    async def vote_route(
        self,
        other_participant_names: List[str],
        history: List[HumanMessage | AIMessage],
        proposer_name: str = "",
        proposed_route_text: str = "",
        current_route_text: str = "No accepted route yet.",
        current_route_score: str = "No current route score available.",
        voting_rule: str = "majority",
        meeting_goal: Optional[str] = None,
        progress_callback: Optional[MessageDeltaCallback] = None,
        retry_callback: Optional[Callable[[int, int, str], Awaitable[None]]] = None,
        allow_search: bool = True,
        ask_handler: Optional[Callable[..., Awaitable[str]]] = None,
        max_steps: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Action-loop vote: search/ask/reflect then accept/reject or scoring."""
        max_steps = max_steps or self.max_steps
        goal = meeting_goal or self._extract_meeting_goal(history)
        is_score_mode = voting_rule in {"most_pleasure", "least_misery"}

        if is_score_mode:
            step_schema = FreeScoreStep if allow_search else FreeScoreStepNoSearch
            vote_prompt = FREE_SCORE_PROMPT
        else:
            step_schema = FreeVoteStep if allow_search else FreeVoteStepNoSearch
            vote_prompt = FREE_VOTE_PROMPT
        format_instr = get_format_instructions(step_schema)
        search_action = _SEARCH_ACTION if allow_search else ""
        voting_rule_description = self._voting_rule_description(voting_rule)

        entries: List[Dict[str, Any]] = []
        ask_exchanges: List[Dict[str, str]] = []
        final_message = ""
        accepted = False
        final_score: Optional[int] = None

        tracker_obj = TokenTracker(self.name)
        total_token_usage = {"input": 0, "output": 0, "cached": 0, "total": 0}
        search_history: List[Dict[str, str]] = []

        async def emit_internal_event(event_type: str, data: Dict[str, Any]):
            if not progress_callback:
                return
            ev_payload = {
                "internal_event": {
                    "event_type": event_type,
                    "task_label": "voting on proposal",
                    "task_focus": f"evaluating {proposer_name}'s proposal",
                    **data,
                }
            }
            try:
                await progress_callback("", ev_payload)
            except Exception:
                logger.exception("Failed to emit %s event for %s", event_type, self.name)

        internal_history = self._to_first_person_history(history)
        internal_history = await self._apply_context_management(internal_history)
        action_history_parts: List[str] = []

        field_names = self._get_field_names(step_schema)
        llm_kwargs = build_litellm_kwargs(self.llm)
        llm_call_log: List[Dict[str, Any]] = []

        for step_number in range(1, max_steps + 1):
            # Build action history text and format the turn prompt for this step
            action_history_text = (
                "\n\n".join(action_history_parts)
                if action_history_parts
                else "(none yet)"
            )
            phase_marker = vote_prompt.format(
                proposer_name=proposer_name,
                proposed_route_text=proposed_route_text,
                current_route_text=current_route_text,
                current_route_score=current_route_score,
                voting_rule_description=voting_rule_description,
                step_number=step_number,
                max_steps=max_steps,
                search_action=search_action,
                action_history=action_history_text,
                format_instructions=format_instr,
            )
            step_history = internal_history + [HumanMessage(content=phase_marker)]

            sys_payload = {
                "name": self.name,
                "background": self.background,
                "personality": self.personality,
                "preferences": self.preferences,
                "role": self.role,
                "personal_goals": self.personal_goals,
                "speaking_style": self.speaking_style,
                "explanation_style": self.explanation_style,
                "num_participants": len(other_participant_names) + 1,
                "other_participants": ", ".join(other_participant_names) if other_participant_names else "none",
                "meeting_title": self.meeting_title,
                "constraints_text": self.constraints_text,
                "meeting_workflow": self.meeting_workflow,
                "meeting_goals": goal,
                "meeting_goal": goal,
                "proposer_name": proposer_name,
                "proposed_route_text": proposed_route_text,
                "current_route_text": current_route_text,
                "voting_rule": voting_rule,
                "voting_rule_description": voting_rule_description,
                "step_number": step_number,
                "max_steps": max_steps,
            }
            step_error_context: List[Dict[str, str]] = []
            result = None
            step_retries = 0
            for _retry in range(self.max_retries):
                try:
                    messages = build_messages(
                        system_template=self.system_prompt_template,
                        history=step_history,
                        payload=sys_payload,
                        format_instructions=format_instr,
                    )
                    if step_error_context:
                        messages.extend(step_error_context)
                    _t0 = time.monotonic()
                    response = await litellm.acompletion(messages=messages, **llm_kwargs)
                    _latency = time.monotonic() - _t0
                    tracker_obj.record_usage(response)
                    content = response.choices[0].message.content or ""
                    tracker_obj.record_content(content)
                    parsed = extract_json(content)
                    result = {key: parsed.get(key) for key in field_names}
                    self._validate_action_required_fields(
                        result,
                        mode="vote",
                        allow_search=allow_search,
                        is_score_mode=is_score_mode,
                    )

                    total_token_usage["input"] = tracker_obj.token_usage.input_tokens
                    total_token_usage["output"] = tracker_obj.token_usage.output_tokens
                    total_token_usage["cached"] = tracker_obj.token_usage.cached_tokens
                    total_token_usage["total"] = tracker_obj.token_usage.total_tokens
                    usage = getattr(response, "usage", None)
                    if usage:
                        llm_call_log.append({
                            "step": step_number,
                            "call_type": "vote",
                            "prompt_tokens": getattr(usage, "prompt_tokens", 0) or 0,
                            "completion_tokens": getattr(usage, "completion_tokens", 0) or 0,
                            "retries": step_retries,
                            "retry_causes": ["json"] * step_retries,
                            "latency_s": round(_latency, 3),
                        })
                    break
                except Exception as exc:
                    step_retries += 1
                    raw_output = getattr(exc, "raw_output", "") or (content if "content" in dir() else "")
                    if raw_output:
                        step_error_context.append({"role": "assistant", "content": raw_output})
                        feedback = (
                            f"Your output could not be parsed. Error: {exc}\n"
                            "Please output valid JSON matching the required schema.\n\n"
                            f"{format_instr}"
                        )
                        step_error_context.append({"role": "user", "content": feedback})
                    logger.warning(
                        "Vote step %d failed for %s (attempt %d/%d): %s",
                        step_number, self.name, _retry + 1, self.max_retries, exc,
                    )
            else:
                logger.warning("Vote step %d failed for %s after %d attempts", step_number, self.name, self.max_retries)
                break

            if not isinstance(result, dict):
                break

            # Sanitize message
            if "message" in result and result["message"] is not None and not isinstance(result["message"], str):
                try:
                    import json as _json
                    result["message"] = _json.dumps(result["message"], ensure_ascii=False)
                except Exception:
                    result["message"] = str(result["message"])

            step = step_schema(**result)

            # Terminal actions go straight to final message — no internal event
            if not is_score_mode and step.action in ("accept", "reject"):
                accepted = step.action == "accept"
                final_message = step.message.strip()
                break
            if is_score_mode and step.action == "scoring":
                accepted = False
                raw_score = getattr(step, "score", None)
                if isinstance(raw_score, int):
                    final_score = max(1, min(10, raw_score))
                else:
                    final_score = 5
                final_message = step.message.strip()
                break

            entry: Dict[str, Any] = {
                "step": step_number,
                "message": step.message,
                "action": step.action,
            }
            entries.append(entry)

            # Emit thinking step (only for internal actions)
            thought_payload: Dict[str, Any] = {
                "step_number": step_number,
                "max_steps": max_steps,
                "action": step.action,
                "task_label": "voting on proposal",
                "task_focus": f"evaluating {proposer_name}'s proposal",
                "thought": step.message,
            }
            if getattr(step, "query", None):
                thought_payload["query"] = step.query
            if step.action == "ask" and getattr(step, "ask_target", None):
                thought_payload["ask_target"] = step.ask_target
            await emit_internal_event("thinking_step", {k: v for k, v in thought_payload.items() if v is not None})

            if step.action == "search":
                query = (getattr(step, "query", None) or "").strip()
                entry["query"] = query
                if not allow_search:
                    observation = "Web search is disabled."
                else:
                    observation = await self._gpt5_search(query, messages=search_history if search_history else None)
                entry["observation"] = observation
                search_history.append({"role": "user", "content": query})
                search_history.append({"role": "assistant", "content": observation})
                action_history_parts.append(
                    f"[Step {step_number}] search: {step.message}\n"
                    f"Query: {query}\nResults: {observation}"
                )
                await emit_internal_event("search_results", {
                    "step_number": step_number, "max_steps": max_steps, "action": "search",
                    "task_label": "voting on proposal",
                    "query": query, "observation": observation,
                })
                continue

            if step.action == "ask":
                target = (getattr(step, "ask_target", None) or "").strip()
                # The step's utterance IS the question — no separate field.
                question = (step.message or "").strip()
                entry["ask_target"] = target
                response_text = ""
                if ask_handler and target and question:
                    try:
                        asker_context = "\n\n".join(action_history_parts) if action_history_parts else None
                        response_text = await ask_handler(target, question, asker_context)
                    except Exception as exc:
                        logger.warning("Ask handler failed for %s asking %s: %s", self.name, target, exc)
                        response_text = f"(Could not get response from {target})"
                entry["ask_response"] = response_text
                ask_exchanges.append({"target": target, "question": question, "response": response_text})
                action_history_parts.append(
                    f"[Step {step_number}] ask: {step.message}\n"
                    f"Target: {target}\nA: {response_text}"
                )
                await emit_internal_event("ask_exchange", {
                    "step_number": step_number, "max_steps": max_steps,
                    "target": target, "question": question, "response": response_text,
                })
                continue

            if step.action == "reflect":
                action_history_parts.append(
                    f"[Step {step_number}] reflect: {step.message}"
                )
                await emit_internal_event("reflection", {
                    "step_number": step_number, "max_steps": max_steps,
                    "notes": step.message,
                })
                continue

        # Build internal log
        log_text = self._build_research_log(entries, final_message)
        await emit_internal_event("complete", {
            "step_number": len(entries), "max_steps": max_steps,
            "log": log_text,
        })

        if is_score_mode:
            score_value = final_score if final_score is not None else 5
            message = final_message or f"I score this proposal {score_value}/10."
        else:
            message = final_message or ("I accept this route." if accepted else "I prefer the current route.")
        self.last_token_usage = total_token_usage
        self.last_llm_calls = llm_call_log

        result_payload: Dict[str, Any] = {
            "accept": accepted,
            "message": message,
            "steps_log": log_text,
            "ask_exchanges": ask_exchanges,
            "token_usage": total_token_usage,
        }
        if is_score_mode:
            score_value = final_score if final_score is not None else 5
            result_payload["score"] = score_value
            result_payload["scores"] = [{"route_id": 1, "score": score_value}]
            result_payload["accept"] = score_value >= 5
        return result_payload

    async def evaluate_final_route(
        self,
        final_route_text: str,
    ) -> Dict[str, Any]:
        """Evaluate the final agreed route against personal goals (post-consensus).

        Returns dict with ``score`` (1-10) and ``reason`` (str).
        """
        payload = self._participant_context([], [], meeting_goals="")
        payload["final_route_text"] = final_route_text

        async def _eval_op(error_context):
            raw, trk = await self._call_llm_invoke(
                pydantic_class=PostConsensusEval,
                human_prompt=POST_CONSENSUS_EVAL_PROMPT,
                payload=payload,
                history=[],
                error_context=error_context or None,
            )
            try:
                result = PostConsensusEval(**raw)
            except ValidationError as exc:
                raise LLMParseError(str(exc), raw_output=_safe_json_text(raw)) from exc
            # Clamp score to 1-10
            score = max(1, min(10, result.score))
            return {"score": score, "reason": result.reason}, trk

        result = await self._retry_with_backoff(
            "Post-consensus evaluation", _eval_op,
            format_instructions=get_format_instructions(PostConsensusEval),
        )
        return result

    async def decide_next_speaker(
        self,
        other_participant_names: List[str],
        history: List[HumanMessage | AIMessage],
        available_candidates: List[str],
        meeting_goal: Optional[str] = None,
        prompt_template: Optional[str] = None,
    ) -> NextSpeakerDecision:
        if not available_candidates:
            raise ValueError("available_candidates must contain at least one participant name.")
        goal = meeting_goal or self._extract_meeting_goal(history)
        prompt = prompt_template or NEXT_SPEAKER_INVITE_PROMPT
        internal_history = self._to_first_person_history(history)
        internal_history = await self._apply_context_management(internal_history)
        payload = self._participant_context(
            other_participant_names,
            internal_history,
            meeting_goal=goal,
            available_candidates_text=", ".join(available_candidates),
        )
        hist = payload.pop("history", [])

        async def _decide_op(error_context):
            result, tracker = await self._call_llm_invoke(
                pydantic_class=NextSpeakerDecision,
                human_prompt=prompt,
                payload=payload,
                history=hist,
                error_context=error_context or None,
            )
            if not isinstance(result, dict):
                raise RuntimeError("Facilitator decision did not return a JSON object.")
            return NextSpeakerDecision(**result), tracker

        return await self._retry_with_backoff(
            "Decide next speaker", _decide_op,
            format_instructions=get_format_instructions(NextSpeakerDecision),
        )
    
    async def answer_question(
        self,
        asker_name: str,
        question: str,
        history: List[HumanMessage | AIMessage],
        meeting_goal: Optional[str] = None,
        current_route_text: str = "",
        progress_callback: Optional[MessageDeltaCallback] = None,
        other_participant_names: Optional[List[str]] = None,
    ) -> str:
        """Generate an immediate response to a question from another participant."""
        goal = meeting_goal or self._extract_meeting_goal(history)
        other_names = other_participant_names if other_participant_names is not None else [asker_name]
        internal_history = self._to_first_person_history(history)
        internal_history = await self._apply_context_management(internal_history)
        payload = self._participant_context(
            other_names,
            internal_history,
            meeting_goal=goal,
            asker_name=asker_name,
            question=question,
            current_route_text=current_route_text or "No accepted route yet.",
        )
        hist = payload.pop("history", [])

        async def _answer_op(error_context):
            if progress_callback:
                raw, tracker = await self._call_llm_streaming(
                    pydantic_class=AskResponse,
                    human_prompt=ASK_RESPONSE_PROMPT,
                    payload=payload,
                    history=hist,
                    progress_callback=progress_callback,
                    error_context=error_context or None,
                )
            else:
                raw, tracker = await self._call_llm_invoke(
                    pydantic_class=AskResponse,
                    human_prompt=ASK_RESPONSE_PROMPT,
                    payload=payload,
                    history=hist,
                    error_context=error_context or None,
                )
            try:
                return AskResponse(**raw), tracker
            except ValidationError as exc:
                raise LLMParseError(str(exc), raw_output=_safe_json_text(raw)) from exc

        result = await self._retry_with_backoff(
            "Answer question", _answer_op,
            format_instructions=get_format_instructions(AskResponse),
        )
        return result.message

    async def free_turn(
        self,
        other_participant_names: List[str],
        history: List[HumanMessage | AIMessage],
        current_route: Optional[List[Any]],
        current_route_destinations: Optional[List[Dict[str, Any]]],
        current_route_text: Optional[str] = None,
        meeting_goal: Optional[str] = None,
        round_number: Optional[int] = 1,
        has_accepted_proposal: bool = False,
        progress_callback: Optional[MessageDeltaCallback] = None,
        ask_handler: Optional[Callable] = None,
        retry_callback: Optional[Callable[[int, int, str], Awaitable[None]]] = None,
        max_steps: Optional[int] = None,
        allow_search: bool = True,
        volunteer_mode: bool = False,
        speaking_position: Optional[str] = None,
        position_guidance: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute one turn in free conversation mode.

        Returns dict with keys:
        - conclusion: "proposal" | "continue" | "satisfied"
        - message: str (public message)
        - route_draft: Optional[RouteDraft] (if proposal)
        - steps_log: str
        - ask_exchanges: List[Dict] ({target, question, response})
        - token_usage: Dict[str, int]
        """
        max_steps = max_steps or self.max_steps
        goal = meeting_goal or self._extract_meeting_goal(history)
        if not current_route_text:
            current_route_text = self._format_route(current_route) if current_route else "No accepted route yet."

        entries: List[Dict[str, Any]] = []
        ask_exchanges: List[Dict[str, str]] = []
        final_summary = ""
        conclusion_type = "continue"

        tracker_obj = TokenTracker(self.name)
        total_token_usage = {"input": 0, "output": 0, "cached": 0, "total": 0}
        search_history: List[Dict[str, str]] = []

        async def emit_internal_event(event_type: str, data: Dict[str, Any]):
            if not progress_callback:
                return
            ev_payload = {
                "internal_event": {
                    "event_type": event_type,
                    "task_label": "free conversation turn",
                    "task_focus": "participating in discussion",
                    **data,
                }
            }
            try:
                await progress_callback("", ev_payload)
            except Exception:
                logger.exception("Failed to emit %s event for %s", event_type, self.name)

        # Select schema
        if volunteer_mode:
            step_schema = FreeActionStepWithPass if allow_search else FreeActionStepNoSearchWithPass
        else:
            step_schema = FreeActionStep if allow_search else FreeActionStepNoSearch
        format_instr = get_format_instructions(step_schema)
        pass_block = _PASS_ACTION if volunteer_mode else ""
        search_action = _SEARCH_ACTION if allow_search else ""

        internal_history = self._to_first_person_history(history)
        internal_history = await self._apply_context_management(internal_history)
        action_history_parts: List[str] = []

        field_names = self._get_field_names(step_schema)
        llm_kwargs = build_litellm_kwargs(self.llm)
        llm_call_log: List[Dict[str, Any]] = []
        turn_structure_text = (
            f"Cycle {round_number}"
            if isinstance(round_number, int) and round_number > 0
            else "Continuous turn selection"
        )

        for step_number in range(1, max_steps + 1):
            # Build action history text and format the turn prompt for this step
            action_history_text = (
                "\n\n".join(action_history_parts)
                if action_history_parts
                else "(none yet)"
            )
            phase_marker = FREE_CONVERSATION_ACTION_PROMPT.format(
                meeting_goal=goal,
                current_route_text=current_route_text,
                other_participants=", ".join(other_participant_names) if other_participant_names else "none",
                round_number=round_number,
                has_accepted_proposal=str(has_accepted_proposal),
                step_number=step_number,
                max_steps=max_steps,
                format_instructions=format_instr,
                pass_block=pass_block,
                search_action=search_action,
                action_history=action_history_text,
                turn_structure_text=turn_structure_text,
                speaking_position=speaking_position or "continuous",
                position_guidance=position_guidance or "",
            )
            step_history = internal_history + [HumanMessage(content=phase_marker)]

            sys_payload = {
                "name": self.name,
                "background": self.background,
                "personality": self.personality,
                "preferences": self.preferences,
                "role": self.role,
                "personal_goals": self.personal_goals,
                "speaking_style": self.speaking_style,
                "explanation_style": self.explanation_style,
                "num_participants": len(other_participant_names) + 1,
                "other_participants": ", ".join(other_participant_names) if other_participant_names else "none",
                "meeting_title": self.meeting_title,
                "constraints_text": self.constraints_text,
                "meeting_workflow": self.meeting_workflow,
                "meeting_goals": goal,
                "meeting_goal": goal,
                "current_route_text": current_route_text,
                "round_number": round_number,
                "turn_structure_text": turn_structure_text,
                "has_accepted_proposal": str(has_accepted_proposal),
                "step_number": step_number,
                "max_steps": max_steps,
            }
            step_error_context: List[Dict[str, str]] = []
            result = None
            step_retries = 0
            for _retry in range(self.max_retries):
                try:
                    messages = build_messages(
                        system_template=self.system_prompt_template,
                        history=step_history,
                        payload=sys_payload,
                        format_instructions=format_instr,
                    )
                    if step_error_context:
                        messages.extend(step_error_context)
                    _t0 = time.monotonic()
                    response = await litellm.acompletion(messages=messages, **llm_kwargs)
                    _latency = time.monotonic() - _t0
                    tracker_obj.record_usage(response)
                    content = response.choices[0].message.content or ""
                    tracker_obj.record_content(content)
                    parsed = extract_json(content)
                    result = {key: parsed.get(key) for key in field_names}
                    self._validate_action_required_fields(
                        result,
                        mode="free_turn",
                        allow_search=allow_search,
                    )

                    total_token_usage["input"] = tracker_obj.token_usage.input_tokens
                    total_token_usage["output"] = tracker_obj.token_usage.output_tokens
                    total_token_usage["cached"] = tracker_obj.token_usage.cached_tokens
                    total_token_usage["total"] = tracker_obj.token_usage.total_tokens
                    usage = getattr(response, "usage", None)
                    if usage:
                        llm_call_log.append({
                            "step": step_number,
                            "call_type": "free_turn",
                            "prompt_tokens": getattr(usage, "prompt_tokens", 0) or 0,
                            "completion_tokens": getattr(usage, "completion_tokens", 0) or 0,
                            "retries": step_retries,
                            "retry_causes": ["json"] * step_retries,
                            "latency_s": round(_latency, 3),
                        })
                    break
                except Exception as exc:
                    step_retries += 1
                    raw_output = getattr(exc, "raw_output", "") or (content if "content" in dir() else "")
                    if raw_output:
                        step_error_context.append({"role": "assistant", "content": raw_output})
                        feedback = (
                            f"Your output could not be parsed. Error: {exc}\n"
                            "Please output valid JSON matching the required schema.\n\n"
                            f"{format_instr}"
                        )
                        step_error_context.append({"role": "user", "content": feedback})
                    logger.warning(
                        "Free turn step %d failed for %s (attempt %d/%d): %s",
                        step_number, self.name, _retry + 1, self.max_retries, exc,
                    )
            else:
                logger.warning("Free turn step %d failed for %s after %d attempts", step_number, self.name, self.max_retries)
                break

            if not isinstance(result, dict):
                break

            # Sanitize message: must be a string (LLM sometimes returns list/dict)
            if "message" in result and result["message"] is not None and not isinstance(result["message"], str):
                try:
                    import json as _json
                    result["message"] = _json.dumps(result["message"], ensure_ascii=False)
                except Exception:
                    result["message"] = str(result["message"])

            step = step_schema(**result)

            # Terminal actions go straight to final message — no internal event
            if step.action in ("propose", "satisfied", "pass"):
                if step.action == "pass":
                    conclusion_type = "pass"
                    final_summary = ""
                    break
                conclusion_type = step.action
                if conclusion_type == "propose":
                    conclusion_type = "proposal"
                final_summary = step.message.strip()
                if step.action == "satisfied" and not has_accepted_proposal:
                    conclusion_type = "continue"
                    if not final_summary:
                        final_summary = "I'd like to continue discussing before proposing."
                # Add terminal action to action_history_parts
                action_history_parts.append(
                    f"[Step {step_number}] {step.action}: {final_summary}"
                )
                break

            entry: Dict[str, Any] = {
                "step": step_number,
                "message": step.message,
                "action": step.action,
            }
            entries.append(entry)

            # Emit thinking step (only for internal actions)
            thought_payload: Dict[str, Any] = {
                "step_number": step_number,
                "max_steps": max_steps,
                "action": step.action,
                "task_label": "free conversation turn",
                "task_focus": "participating in discussion",
                "thought": step.message,
            }
            if getattr(step, "query", None):
                thought_payload["query"] = step.query
            if step.action == "ask" and getattr(step, "ask_target", None):
                thought_payload["ask_target"] = step.ask_target
            await emit_internal_event("thinking_step", {k: v for k, v in thought_payload.items() if v is not None})

            if step.action == "search":
                query = (getattr(step, "query", None) or "").strip()
                entry["query"] = query
                if not allow_search:
                    observation = "Web search is disabled."
                else:
                    observation = await self._gpt5_search(query, messages=search_history if search_history else None)
                entry["observation"] = observation
                search_history.append({"role": "user", "content": query})
                search_history.append({"role": "assistant", "content": observation})
                action_history_parts.append(
                    f"[Step {step_number}] search: {step.message}\n"
                    f"Query: {query}\nResults: {observation}"
                )
                await emit_internal_event("search_results", {
                    "step_number": step_number, "max_steps": max_steps, "action": "search",
                    "task_label": "free conversation turn", "task_focus": "participating in discussion",
                    "query": query, "observation": observation,
                })
                continue

            if step.action == "ask":
                target = (getattr(step, "ask_target", None) or "").strip()
                # The step's utterance IS the question — no separate field.
                question = (step.message or "").strip()
                entry["ask_target"] = target
                response_text = ""
                if ask_handler and target and question:
                    try:
                        asker_context = "\n\n".join(action_history_parts) if action_history_parts else None
                        response_text = await ask_handler(target, question, asker_context)
                    except Exception as exc:
                        logger.warning("Ask handler failed for %s asking %s: %s", self.name, target, exc)
                        response_text = f"(Could not get response from {target})"
                entry["ask_response"] = response_text
                ask_exchanges.append({"target": target, "question": question, "response": response_text})
                action_history_parts.append(
                    f"[Step {step_number}] ask: {step.message}\n"
                    f"Target: {target}\nA: {response_text}"
                )
                await emit_internal_event("ask_exchange", {
                    "step_number": step_number, "max_steps": max_steps,
                    "target": target, "question": question, "response": response_text,
                })
                continue

            if step.action == "reflect":
                action_history_parts.append(
                    f"[Step {step_number}] reflect: {step.message}"
                )
                await emit_internal_event("reflection", {
                    "step_number": step_number, "max_steps": max_steps,
                    "notes": step.message,
                })
                continue


        # Build internal log
        log_text = self._build_research_log(entries, final_summary)
        await emit_internal_event("complete", {
            "step_number": len(entries), "max_steps": max_steps,
            "log": log_text,
        })

        # Message is always from the FreeActionStep — no second LLM call for text
        message = final_summary
        if not message and conclusion_type == "satisfied":
            message = "I'm satisfied with the current route."

        # If proposal, generate the structured route via RouteDraft (route only, message already set)
        route_draft = None
        if conclusion_type == "proposal":
            # Surface the conclude message immediately so the UI can display it
            # (with a typing indicator) while the route JSON is being generated.
            await emit_internal_event("thinking_step", {
                "step_number": len(entries) + 1, "max_steps": max_steps,
                "action": "conclude", "thought": message,
            })
            payload = self._participant_context(
                other_participant_names, internal_history,
                meeting_goal=goal,
            )
            payload["action_history"] = (
                "\n\n".join(action_history_parts)
                if action_history_parts
                else "(none)"
            )
            hist = payload.pop("history", [])

            _last_valid_draft: List[Optional[RouteDraft]] = [None]
            _last_violations: List[Optional[List[str]]] = [None]

            async def _proposal_op(error_context):
                raw, trk = await self._call_llm_invoke(
                    pydantic_class=RouteDraft,
                    human_prompt=FREE_PROPOSAL_PROMPT,
                    payload=payload,
                    history=hist,
                    error_context=error_context or None,
                )
                sanitized = Participant._sanitize_route_payload(dict(raw))
                try:
                    draft = RouteDraft(**sanitized)
                except ValidationError as exc:
                    raise LLMParseError(
                        str(exc),
                        raw_output=_safe_json_text(sanitized),
                    ) from exc
                # Validate timing consistency and the meeting's time window
                time_violations = validate_route_times(
                    draft,
                    time_window_start=self.time_window_start,
                    time_window_end=self.time_window_end,
                )
                if time_violations:
                    _last_valid_draft[0] = draft
                    _last_violations[0] = time_violations
                    violations_text = "\n".join(time_violations)
                    raise RouteTimeViolation(
                        f"The proposed route has timing violations:\n{violations_text}\n"
                        "Please fix the start_time of each destination so that "
                        "start_time >= (previous start_time + previous stay_duration + travel_time_from_previous), "
                        "and keep every stop within the meeting's time window.",
                        raw_output=_safe_json_text(sanitized),
                    )
                # Validate cost format (currency symbol + number only)
                cost_violations = validate_route_costs(draft)
                if cost_violations:
                    _last_valid_draft[0] = draft
                    _last_violations[0] = cost_violations
                    violations_text = "\n".join(cost_violations)
                    raise RouteCostViolation(
                        f"The proposed route has invalid cost values:\n{violations_text}\n"
                        "Set every cost and transport_cost to a currency symbol followed "
                        "by a number only (e.g., '$20', '¥1500'; use '$0'/'¥0' if free).",
                        raw_output=_safe_json_text(sanitized),
                    )
                return draft, trk

            try:
                route_draft = await self._retry_with_backoff(
                    "Free conversation proposal", _proposal_op, total_token_usage, retry_callback,
                    format_instructions=get_format_instructions(RouteDraft),
                )
            except (RouteTimeViolation, RouteCostViolation):
                # All retries exhausted but we have a parseable draft with
                # time or cost violations. Fall through with the last draft;
                # correct_route_times() fixes times and detect_currency_symbol()
                # ignores malformed costs, and the violations are logged.
                route_draft = _last_valid_draft[0]
                if route_draft is not None:
                    violations = _last_violations[0] or []
                    logger.warning(
                        f"Route proposal by {self.name} has unfixed violations after "
                        f"{self.max_retries} retries. Falling back to the last draft. "
                        f"Violations: {violations}"
                    )
            # _retry_with_backoff sets self.last_llm_calls; merge into llm_call_log
            llm_call_log.extend(self.last_llm_calls)
        self.last_token_usage = total_token_usage
        self.last_llm_calls = llm_call_log

        return {
            "conclusion": conclusion_type,
            "message": message,
            "route_draft": route_draft,
            "steps_log": log_text,
            "ask_exchanges": ask_exchanges,
            "token_usage": total_token_usage,
            "total_steps": len(entries) + (1 if conclusion_type != "pass" else 0),
            "max_steps": max_steps,
        }

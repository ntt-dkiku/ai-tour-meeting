from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field

from .participant import Destination, RouteDraft

# Domain events the core can emit (transport-agnostic)
@dataclass
class MeetingStarted:
    goal: str

@dataclass
class TurnStart:
    turn: int
    speaker: str

@dataclass
class Delta:
    turn: int
    speaker: str
    delta: str
    metadata: Optional[Dict[str, Any]] = None

@dataclass
class TurnFinal:
    turn: int
    speaker: str
    text: str
    route_plan: Optional[Dict[str, Any]] = None
    steps_log: Optional[str] = None
    steps_label: Optional[str] = None
    max_steps: Optional[int] = None
    score: Optional[float] = None
    need_modification: Optional[bool] = None

@dataclass
class HumanTurn:
    turn: int
    speaker: str
    # The human turn is a multi-step action loop mirroring the LLM participants:
    # they may ask (intermediate) then finish with speak/propose/satisfied.
    step: int = 1
    max_steps: int = 1
    candidates: List[str] = field(default_factory=list)  # askable participant names
    can_ask: bool = True     # false on the final step (must conclude)
    can_propose: bool = True
    # The currently accepted route's destinations (empty if none), so the
    # propose editor can seed itself with it as an editable starting point.
    current_route: List[Dict[str, Any]] = field(default_factory=list)
    # Conversation history so far: {"speaker", "text", "turn"} in order.
    conversation_history: List[Dict[str, Any]] = field(default_factory=list)
    # Q&A from this turn's earlier ask steps: {"target", "question", "response"}.
    ask_exchanges: List[Dict[str, Any]] = field(default_factory=list)

@dataclass
class HumanVote:
    turn: int
    speaker: str
    vote_type: str  # "route" or "consensus"
    options: Dict[str, Any]  # voting options (e.g., proposals for route voting)
    # Voting is also a multi-step loop: ask (intermediate) then judge (final).
    step: int = 1
    max_steps: int = 1
    candidates: List[str] = field(default_factory=list)  # askable participant names
    can_ask: bool = True     # false on the final step (must judge)
    # Conversation history so far: {"speaker", "text", "turn"} in order.
    conversation_history: List[Dict[str, Any]] = field(default_factory=list)
    # Q&A from this vote's earlier ask steps: {"target", "question", "response"}.
    ask_exchanges: List[Dict[str, Any]] = field(default_factory=list)

@dataclass
class HumanSelectSpeaker:
    """Prompt the human (acting as facilitator) to pick who speaks next."""
    turn: int
    speaker: str  # the human facilitator's name
    candidates: List[str]  # engine names the human may choose from
    # Conversation history so far: {"speaker", "text", "turn"} in order.
    conversation_history: List[Dict[str, Any]] = field(default_factory=list)

@dataclass
class HumanAsk:
    """An LLM participant asked the human a question; awaits their answer."""
    turn: int
    asker: str
    target: str  # the human participant's name
    question: str
    # Conversation history so far: {"speaker", "text", "turn"} in order.
    conversation_history: List[Dict[str, Any]] = field(default_factory=list)

@dataclass
class PhaseMessage:
    title: str
    description: Optional[str] = None

@dataclass
class RoutePlanUpdate:
    turn: int
    speaker: str
    route_plan: Dict[str, Any]

@dataclass
class Timeout:
    pass

@dataclass
class MeetingFinished:
    turns: int

@dataclass
class RetryNotification:
    turn: int
    speaker: str
    attempt: int
    max_attempts: int
    error_message: str

@dataclass
class AskPending:
    """An agent asked another agent a question; the answer is being generated."""
    turn: int
    asker: str
    target: str
    question: str

@dataclass
class AskExchange:
    """An agent asked another agent a question and received a response."""
    turn: int
    asker: str
    target: str
    question: str
    response: str

@dataclass
class ProposalVoteResult:
    """Result of voting on a route proposal."""
    turn: int
    proposer: str
    accepted: bool
    vote_summary: Dict[str, Any]

@dataclass
class SatisfiedUpdate:
    """A participant expressed satisfaction (or not) with the current route."""
    turn: int
    speaker: str
    satisfied: bool
    satisfied_count: int
    total_count: int

@dataclass
class RoundEnd:
    """Signals the end of a conversation round (all participants spoke once)."""
    round_number: int

@dataclass
class DeadlockIntervention:
    """The system detected a deadlocked discussion and injected a mediation
    message that every participant sees on their next turn."""
    turn: int
    message: str
    signals: List[str] = field(default_factory=list)

@dataclass
class AdviceInjected:
    """External advice (queued via AITourMeeting.inject_advice) was injected
    into the shared history; every participant sees it on their next turn."""
    turn: int
    source: str
    message: str

MeetingEvent = Union[
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
]


# Aliases for the external-system events (an external system takes the seat
# the human-facing events address; see tour_meeting.integration).
ExternalSystemTurn = HumanTurn
ExternalSystemVote = HumanVote
ExternalSystemAsk = HumanAsk
ExternalSystemSelectSpeaker = HumanSelectSpeaker


# ---------------------------------------------------------------------------
# Typed actions an external system returns from its callbacks
# ---------------------------------------------------------------------------
class Speak(BaseModel):
    """Say something without concluding the turn with a proposal."""
    action: Literal["speak"] = "speak"
    message: str = ""


class Ask(BaseModel):
    """Ask another participant a question (intermediate; repeatable)."""
    action: Literal["ask"] = "ask"
    target: str
    message: str


class Propose(BaseModel):
    """Propose an itinerary; it will be voted on by the other participants."""
    action: Literal["propose"] = "propose"
    message: str = ""
    route: List[Destination] = Field(default_factory=list)


class Satisfied(BaseModel):
    """Agree to conclude the meeting with the current itinerary."""
    action: Literal["satisfied"] = "satisfied"
    message: str = ""


TurnAction = Union[Speak, Ask, Propose, Satisfied]


class Vote(BaseModel):
    """A judgment on another participant's proposal.

    Set ``accept`` for the binary voting rules (majority / unanimous /
    single_decider) or ``score`` (1-10) for most_pleasure / least_misery.
    """
    accept: Optional[bool] = None
    score: Optional[float] = None
    message: str = ""

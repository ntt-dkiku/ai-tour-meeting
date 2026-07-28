"""Base class for integrating external systems into a meeting.

Subclass :class:`ExternalSystem`, override the callbacks you need, and add
the instance to the meeting's participants like any other participant::

    class MyRecSys(ExternalSystem):
        name = "RecSys"

        def on_turn(self, event: ExternalSystemTurn) -> Propose:
            return Propose(message="...", route=[Destination(...), ...])

        def on_vote(self, event: ExternalSystemVote) -> Vote:
            return Vote(accept=True, message="Works for me.")

    meeting = build_meeting(..., participants=[alice, MyRecSys(), bob])
    asyncio.run(meeting.run_cli())

Callbacks may be sync or async. See the "Evaluate your system" page of the
docs for the event/payload formats.
"""
from __future__ import annotations

from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .tour_meeting import AITourMeeting

from .types import (
    ExternalSystemAsk,
    ExternalSystemSelectSpeaker,
    ExternalSystemTurn,
    ExternalSystemVote,
    MeetingEvent,
    TurnAction,
    Vote,
)


class ExternalSystem:
    """An external system (e.g., a recommender) plugged into a meeting.

    Overriding :meth:`on_turn` gives the system a seat in the meeting (it
    speaks, proposes, and votes like any other participant). Overriding only
    :meth:`on_event` makes it an advisor: no seat, but it observes every
    event and may guide the agents with :meth:`advise`.

    Attributes:
        name: The system's display name in the meeting.
    """

    name: str = "ExternalSystem"

    def __init__(self) -> None:
        # Bound by AITourMeeting.add_external_system
        self.meeting: Optional["AITourMeeting"] = None

    @property
    def participate(self) -> bool:
        """Whether the system takes a seat: True iff it overrides on_turn."""
        return type(self).on_turn is not ExternalSystem.on_turn

    # ------------------------------------------------------------------
    # Participant callbacks (used when the system takes a seat)
    # ------------------------------------------------------------------
    def on_turn(self, event: ExternalSystemTurn) -> TurnAction:
        """Return the action for the system's speaking turn.

        e.g. ``Propose(message="...", route=[Destination(...), ...])``,
        ``Speak(message="...")``, ``Ask(target="...", message="...")``, or
        ``Satisfied()``.
        """
        raise NotImplementedError("Override on_turn to act on the system's turns.")

    def on_vote(self, event: ExternalSystemVote) -> Vote:
        """Return the vote on another participant's proposal.

        e.g. ``Vote(accept=True, message="...")`` or ``Vote(score=8)``.
        """
        raise NotImplementedError("Override on_vote to vote on proposals.")

    def on_ask(self, event: ExternalSystemAsk) -> str:
        """Return the answer to an agent's question (defaults to no answer)."""
        return ""

    def on_select_speaker(self, event: ExternalSystemSelectSpeaker) -> str:
        """Pick the next speaker when the system facilitates (defaults to
        the first candidate)."""
        return event.candidates[0] if event.candidates else ""

    # ------------------------------------------------------------------
    # Observer callback (every event, regardless of participate)
    # ------------------------------------------------------------------
    def on_event(self, event: MeetingEvent) -> None:
        """Observe every meeting event (utterances, proposals, votes, ...)."""

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def advise(self, message: str) -> None:
        """Inject advice that every agent sees on their next turn."""
        if self.meeting is None:
            raise RuntimeError(
                "The system is not attached to a meeting yet; "
                "add it to the meeting's participants first."
            )
        self.meeting.inject_advice(message, source=self.name)

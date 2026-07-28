"""Tests for the ExternalSystem integration (Evaluate your system).

An external system joins the participants list like any other participant;
its callbacks are dispatched automatically by run_free_conversation. These
tests cover seating (position/order, participate auto-detection), the typed
actions, the event payloads (conversation_history, ask_exchanges), voting,
and advisor-style advice injection.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tour_meeting.cli import build_meeting
from tour_meeting.integration import ExternalSystem
from tour_meeting.types import (
    AdviceInjected,
    Ask,
    ExternalSystemTurn,
    ExternalSystemVote,
    ProposalVoteResult,
    Speak,
    TurnFinal,
    TurnStart,
    Vote,
)

pytestmark = pytest.mark.asyncio(loop_scope="function")

RUN_TIMEOUT = 10.0


def _participant(name: str, max_steps: int = 3) -> Dict[str, Any]:
    return {
        "name": name,
        "model_name": "test/mock",
        "background": f"{name} is a test participant.",
        "personality": "Curious.",
        "preferences": "Efficient discussions.",
        "personal_goals": "Test goals.",
        "role": "attendee",
        "temperature": 0.0,
        "max_steps": max_steps,
        "web_search": False,
    }


def _make_llm_response(content: str):
    choice = MagicMock()
    choice.message = MagicMock()
    choice.message.content = content
    choice.finish_reason = "stop"
    usage = MagicMock()
    usage.prompt_tokens = 10
    usage.completion_tokens = 5
    usage.total_tokens = 15
    response = MagicMock()
    response.choices = [choice]
    response.usage = usage
    return response


def _side_effect(responses: List[str]):
    idx = 0

    async def se(*args, **kwargs):
        nonlocal idx
        content = responses[idx] if idx < len(responses) else json.dumps(
            {"action": "satisfied", "message": "done"}
        )
        idx += 1
        return _make_llm_response(content)

    return se


_ROUTE_JSON = [
    {
        "name": "Museum",
        "description": "A nice museum",
        "transport_mode": "walk",
        "transport_cost": "$0",
        "travel_time_from_previous": "10 min",
        "start_time": "10:00",
        "stay_duration": "60 min",
        "cost": "$10",
    },
    {
        "name": "Park",
        "description": "A quiet park",
        "transport_mode": "walk",
        "transport_cost": "$0",
        "travel_time_from_previous": "15 min",
        "start_time": "11:15",
        "stay_duration": "45 min",
        "cost": "$0",
    },
]


class _SpeakOnce(ExternalSystem):
    """Speaks on its turns; accepts every proposal."""

    name = "RecSys"

    def __init__(self) -> None:
        super().__init__()
        self.turn_events: List[ExternalSystemTurn] = []
        self.vote_events: List[ExternalSystemVote] = []

    def on_turn(self, event: ExternalSystemTurn) -> Speak:
        self.turn_events.append(event)
        return Speak(message="hello from the system")

    def on_vote(self, event: ExternalSystemVote) -> Vote:
        self.vote_events.append(event)
        return Vote(accept=True, message="fine by me")


def _build(participants: List[Any], max_turns: int = 4):
    return build_meeting(
        title="External System",
        global_goals="Plan a test tour.",
        participants=participants,
        settings={
            "turn_rule": "round_robin",
            "voting_rule": "majority",
            "max_turns": max_turns,
            "balanced_turns": True,
        },
    )


async def _drive(meeting, until, responses: List[str]):
    """Run the meeting, collecting events until ``until(events)`` is true."""
    events: List[Any] = []

    async def loop():
        async for event in meeting.run_free_conversation():
            events.append(event)
            if until(events):
                break

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect(responses)
        await asyncio.wait_for(loop(), timeout=RUN_TIMEOUT)
    return events


# ── Seating ──────────────────────────────────────────────────────────────


async def test_system_seated_at_list_position():
    """The system's position in participants is its speaking-order position."""
    system = _SpeakOnce()
    meeting = _build([system, _participant("P0")])

    events = await _drive(
        meeting,
        until=lambda evs: any(isinstance(e, TurnFinal) for e in evs),
        responses=[],
    )

    assert meeting._order == ["__YOU__", "P0"]
    first_turn = next(e for e in events if isinstance(e, TurnStart))
    assert first_turn.speaker == "RecSys"
    final = next(e for e in events if isinstance(e, TurnFinal))
    assert final.speaker == "RecSys"
    assert final.text == "hello from the system"


async def test_only_one_external_system():
    system = _SpeakOnce()
    meeting = _build([system, _participant("P0")])
    with pytest.raises(ValueError):
        meeting.add_external_system(_SpeakOnce())


async def test_participate_auto_detection():
    """Overriding on_turn takes a seat; overriding only on_event does not."""

    class Advisor(ExternalSystem):
        def on_event(self, event) -> None:
            pass

    assert _SpeakOnce().participate is True
    assert Advisor().participate is False

    meeting = _build([_participant("P0"), Advisor()])
    assert meeting._human_enabled is False


# ── Event payloads ───────────────────────────────────────────────────────


async def test_turn_event_carries_conversation_history():
    """By the system's turn, P0's utterance is in event.conversation_history."""
    system = _SpeakOnce()
    meeting = _build([_participant("P0"), system])

    await _drive(
        meeting,
        until=lambda evs: any(
            isinstance(e, TurnFinal) and e.speaker == "RecSys" for e in evs
        ),
        responses=[json.dumps({"action": "satisfied", "message": "P0 speaks first."})],
    )

    assert system.turn_events
    history = system.turn_events[0].conversation_history
    assert any(entry["speaker"] == "P0" for entry in history)


async def test_ask_exchanges_surface_on_next_step():
    """An Ask's answer arrives via ask_exchanges on the following step."""

    class AskThenSpeak(ExternalSystem):
        name = "RecSys"

        def __init__(self) -> None:
            super().__init__()
            self.seen_exchanges: List[Dict[str, Any]] = []

        def on_turn(self, event: ExternalSystemTurn):
            if not event.ask_exchanges:
                return Ask(target="P0", message="What's your budget?")
            self.seen_exchanges = event.ask_exchanges
            return Speak(message="thanks")

        def on_vote(self, event: ExternalSystemVote) -> Vote:
            return Vote(accept=True)

    system = AskThenSpeak()
    meeting = _build([system, _participant("P0")])

    await _drive(
        meeting,
        until=lambda evs: any(
            isinstance(e, TurnFinal) and e.speaker == "RecSys" for e in evs
        ),
        responses=[json.dumps({"message": "Around $100."})],  # P0.answer_question
    )

    assert system.seen_exchanges == [
        {"target": "P0", "question": "What's your budget?", "response": "Around $100."}
    ]


# ── Voting ───────────────────────────────────────────────────────────────


async def test_system_votes_on_llm_proposal():
    """A seated system receives HumanVote for P0's proposal and its Vote counts."""
    system = _SpeakOnce()
    meeting = _build([_participant("P0", max_steps=2), system])
    responses = [
        json.dumps({"action": "propose", "message": "How about this route?"}),
        json.dumps({"message": "Here's the route.", "route": _ROUTE_JSON}),
    ]

    events = await _drive(
        meeting,
        until=lambda evs: any(isinstance(e, ProposalVoteResult) for e in evs),
        responses=responses,
    )

    assert system.vote_events, "the system should be asked to vote"
    proposals = system.vote_events[0].options["proposals"]
    assert proposals and proposals[0]["participant"] == "P0"
    result = next(e for e in events if isinstance(e, ProposalVoteResult))
    assert result.proposer == "P0"
    assert result.accepted is True
    assert meeting.final_route is not None
    assert [d["name"] for d in meeting.final_route] == ["Museum", "Park"]


# ── Advisor ──────────────────────────────────────────────────────────────


async def test_advisor_advice_reaches_history():
    """advise() lands in the shared history and emits AdviceInjected."""

    class Coach(ExternalSystem):
        name = "Coach"

        def __init__(self) -> None:
            super().__init__()
            self.advised = False

        def on_event(self, event) -> None:
            if isinstance(event, TurnFinal) and not self.advised:
                self.advised = True
                self.advise("Mind the budget.")

    coach = Coach()
    meeting = _build([_participant("P0"), coach], max_turns=2)

    events = await _drive(
        meeting,
        until=lambda evs: any(isinstance(e, AdviceInjected) for e in evs),
        responses=[],
    )

    injected = next(e for e in events if isinstance(e, AdviceInjected))
    assert injected.source == "Coach"
    assert injected.message == "Mind the budget."
    assert any(
        "Advice from Coach" in m.content and "Mind the budget." in m.content
        for m in meeting.history
        if isinstance(m.content, str)
    )


async def test_advise_requires_attachment():
    class Coach(ExternalSystem):
        def on_event(self, event) -> None:
            pass

    with pytest.raises(RuntimeError):
        Coach().advise("too early")

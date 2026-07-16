"""Tests for the single_decider voting rule.

Verifies that:
- Only the designated decider casts a vote
- The decider's accept/reject alone decides the outcome
- A proposal by the decider is accepted implicitly (no voting round)
- An unset/stale decider falls back to the first participant in order
- The workflow text names the decider for all participants
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tour_meeting.cli import build_meeting
from tour_meeting.types import (
    TurnStart,
    PhaseMessage,
    ProposalVoteResult,
)

pytestmark = pytest.mark.asyncio(loop_scope="function")


def _participant(name: str, role: str = "attendee", **overrides) -> Dict[str, Any]:
    base = {
        "name": name,
        "model_name": "test/mock",
        "background": f"{name} is a test participant.",
        "personality": "Curious and cooperative.",
        "preferences": "Enjoys efficient discussions.",
        "personal_goals": "Test goals.",
        "role": role,
        "temperature": 0.0,
        "max_steps": 1,
        "web_search": False,
    }
    base.update(overrides)
    return base


def _make_meeting(num_participants: int = 3, single_decider: Optional[str] = None):
    participants = [
        _participant(f"P{i}", role="facilitator" if i == 0 else "attendee")
        for i in range(num_participants)
    ]
    settings = {
        "turn_rule": "round_robin",
        "vote_turn_rule": "round_robin",
        "voting_rule": "single_decider",
        "single_decider": single_decider,
        "max_turns": 30,
        "time_limit": None,
        "volunteer_mode": False,
        "balanced_turns": True,
    }
    return build_meeting(
        title="Test Meeting",
        global_goals="Plan a test tour.",
        participants=participants,
        settings=settings,
    )


def _make_llm_response(content: str):
    choice = MagicMock()
    choice.message = MagicMock()
    choice.message.content = content
    choice.finish_reason = "stop"

    usage = MagicMock()
    usage.prompt_tokens = 50
    usage.completion_tokens = 20
    usage.total_tokens = 70

    response = MagicMock()
    response.choices = [choice]
    response.usage = usage
    return response


# At least two destinations: proposals with fewer are skipped without a vote.
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


def _propose_action() -> str:
    return json.dumps({"action": "propose", "message": "Let me propose a route."})


def _route_draft() -> str:
    return json.dumps({"message": "Here's my route proposal.", "route": _ROUTE_JSON})


def _accept_vote(msg: str = "I accept!") -> str:
    return json.dumps({"action": "accept", "message": msg})


def _reject_vote(msg: str = "I reject.") -> str:
    return json.dumps({"action": "reject", "message": msg})


def _satisfied_action(msg: str = "I'm satisfied.") -> str:
    return json.dumps({"action": "satisfied", "message": msg})


def _build_mock_side_effect(responses):
    idx = 0

    async def side_effect(*args, **kwargs):
        nonlocal idx
        if idx < len(responses):
            content = responses[idx]
            idx += 1
        else:
            content = _satisfied_action()
        return _make_llm_response(content)

    return side_effect


async def _run_until_vote_result(meeting, responses):
    """Run the meeting, returning (events, first ProposalVoteResult)."""
    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _build_mock_side_effect(responses)

        events = []
        vote_result = None
        async for event in meeting.run_free_conversation():
            events.append(event)
            if isinstance(event, ProposalVoteResult):
                vote_result = event
                break
    return events, vote_result


@pytest.mark.asyncio
async def test_single_decider_only_decider_votes():
    """Only the designated decider casts a vote; other attendees are skipped."""
    meeting = _make_meeting(num_participants=3, single_decider="P2")

    responses = [
        _propose_action(),  # P0 free_turn: propose
        _route_draft(),     # P0 route generation
        _accept_vote(),     # P2 (decider) vote — P1 never votes
    ]

    events, vote_result = await _run_until_vote_result(meeting, responses)

    assert vote_result is not None
    assert vote_result.accepted is True
    summary = vote_result.vote_summary
    assert summary["total_votes"] == 1
    assert summary["votes"][0]["participant"] == "P2"

    # Exactly one voting TurnStart, and it belongs to the decider.
    voting_phase_idx = next(
        i for i, ev in enumerate(events)
        if isinstance(ev, PhaseMessage) and "Voting" in (ev.title or "")
    )
    vote_speakers = [
        ev.speaker for ev in events[voting_phase_idx:] if isinstance(ev, TurnStart)
    ]
    assert vote_speakers == ["P2"]

    # All participants are told who the decider is.
    for p in meeting.participants:
        assert "designated decider: P2" in p.meeting_workflow


@pytest.mark.asyncio
async def test_single_decider_reject_overrules_everyone():
    """A single reject from the decider rejects the proposal."""
    meeting = _make_meeting(num_participants=3, single_decider="P2")

    responses = [
        _propose_action(),
        _route_draft(),
        _reject_vote(),  # P2 (decider) rejects
    ]

    _, vote_result = await _run_until_vote_result(meeting, responses)

    assert vote_result is not None
    assert vote_result.accepted is False
    assert vote_result.vote_summary["total_votes"] == 1


@pytest.mark.asyncio
async def test_single_decider_own_proposal_is_accepted_without_votes():
    """When the decider proposes, the proposal is accepted with no voting round."""
    meeting = _make_meeting(num_participants=3, single_decider="P0")

    responses = [
        _propose_action(),  # P0 (decider) free_turn: propose
        _route_draft(),     # P0 route generation
    ]

    events, vote_result = await _run_until_vote_result(meeting, responses)

    assert vote_result is not None
    assert vote_result.accepted is True
    assert vote_result.vote_summary["total_votes"] == 0

    # No voting turns at all between the voting phase and the result.
    voting_phase_idx = next(
        i for i, ev in enumerate(events)
        if isinstance(ev, PhaseMessage) and "Voting" in (ev.title or "")
    )
    vote_speakers = [
        ev.speaker for ev in events[voting_phase_idx:] if isinstance(ev, TurnStart)
    ]
    assert vote_speakers == []


@pytest.mark.asyncio
async def test_single_decider_unset_falls_back_to_first_participant():
    """With no decider configured, the first participant in order decides."""
    meeting = _make_meeting(num_participants=3, single_decider=None)

    # P0 (the fallback decider) proposes, so it is accepted implicitly.
    responses = [
        _propose_action(),
        _route_draft(),
    ]

    _, vote_result = await _run_until_vote_result(meeting, responses)

    assert vote_result is not None
    assert vote_result.accepted is True
    assert vote_result.vote_summary["total_votes"] == 0
    for p in meeting.participants:
        assert "designated decider: P0" in p.meeting_workflow

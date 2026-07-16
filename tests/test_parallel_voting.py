"""Tests for parallel voting (vote_turn_rule='parallel').

Verifies that:
- All voters execute concurrently via asyncio.gather
- Each vote counts as one individual turn (TurnStart + TurnFinal per voter)
- Event order matches sequential voting pattern
- Analytics are recorded correctly for each vote
- vote_records are populated and tally code works normally
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tour_meeting.cli import build_meeting
from tour_meeting.types import (
    TurnStart,
    TurnFinal,
    PhaseMessage,
    ProposalVoteResult,
    MeetingFinished,
)

pytestmark = pytest.mark.asyncio(loop_scope="function")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

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


def _make_meeting(num_participants: int = 3, vote_turn_rule: str = "parallel"):
    """Build a meeting with N participants and parallel voting."""
    participants = [
        _participant(f"P{i}", role="facilitator" if i == 0 else "attendee")
        for i in range(num_participants)
    ]
    settings = {
        "turn_rule": "round_robin",
        "vote_turn_rule": vote_turn_rule,
        "voting_rule": "majority",
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
    """Build a mock litellm response."""
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
    """Free turn response: propose action."""
    return json.dumps({"action": "propose", "message": "Let me propose a route."})


def _route_draft() -> str:
    """Route generation response (second LLM call for proposal)."""
    return json.dumps({"message": "Here's my route proposal.", "route": _ROUTE_JSON})


def _accept_vote(msg: str = "I accept!") -> str:
    """Vote action: accept."""
    return json.dumps({"action": "accept", "message": msg})


def _reject_vote(msg: str = "I reject.") -> str:
    """Vote action: reject."""
    return json.dumps({"action": "reject", "message": msg})


def _satisfied_action(msg: str = "I'm satisfied.") -> str:
    """Free turn response: satisfied action."""
    return json.dumps({"action": "satisfied", "message": msg})


def _build_mock_side_effect(responses):
    """Build an acompletion side_effect from a list of response strings.

    Any calls beyond the list return satisfied.
    """
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


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_parallel_voting_produces_individual_turns():
    """Each voter in parallel mode gets their own TurnStart + TurnFinal."""
    meeting = _make_meeting(num_participants=3, vote_turn_rule="parallel")
    # P0 proposes (2 LLM calls), P1 and P2 vote (1 each), then all 3 satisfied
    responses = [
        _propose_action(),   # P0 free_turn: propose
        _route_draft(),      # P0 route generation
        _accept_vote(),      # P1 vote
        _accept_vote(),      # P2 vote
        # After voting: P1, P2, P0 say satisfied (round_robin continues from P0)
        _satisfied_action(), # P1 satisfied
        _satisfied_action(), # P2 satisfied
        _satisfied_action(), # P0 satisfied
    ]

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _build_mock_side_effect(responses)

        events = []
        async for event in meeting.run_free_conversation():
            events.append(event)

    # Find voting phase
    voting_phase_idx = None
    for i, ev in enumerate(events):
        if isinstance(ev, PhaseMessage) and "Voting" in (ev.title or ""):
            voting_phase_idx = i
            break

    assert voting_phase_idx is not None, "Should have a voting phase"

    # Collect TurnStart and TurnFinal events during voting (before ProposalVoteResult)
    vote_turn_starts = []
    vote_turn_finals = []
    for ev in events[voting_phase_idx:]:
        if isinstance(ev, ProposalVoteResult):
            break
        if isinstance(ev, TurnStart):
            vote_turn_starts.append(ev)
        if isinstance(ev, TurnFinal):
            vote_turn_finals.append(ev)

    # 2 voters (P1, P2) = 2 TurnStart + 2 TurnFinal
    assert len(vote_turn_starts) == 2, f"Expected 2 TurnStart, got {len(vote_turn_starts)}: {vote_turn_starts}"
    assert len(vote_turn_finals) == 2, f"Expected 2 TurnFinal, got {len(vote_turn_finals)}: {vote_turn_finals}"

    # Each vote has a distinct, sequential turn number
    turns = [ts.turn for ts in vote_turn_starts]
    assert turns[1] == turns[0] + 1, f"Turn numbers should be sequential: {turns}"

    # Speakers should be the non-proposer participants
    speakers = {ts.speaker for ts in vote_turn_starts}
    assert speakers == {"P1", "P2"}, f"Expected P1 and P2 as voters, got {speakers}"


@pytest.mark.asyncio
async def test_parallel_voting_populates_vote_records():
    """Parallel voting should produce a ProposalVoteResult with correct tally."""
    meeting = _make_meeting(num_participants=3, vote_turn_rule="parallel")

    responses = [
        _propose_action(),
        _route_draft(),
        _accept_vote("P1 accepts"),
        _reject_vote("P2 rejects"),
        _satisfied_action(),
        _satisfied_action(),
        _satisfied_action(),
    ]

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _build_mock_side_effect(responses)

        vote_results = []
        async for event in meeting.run_free_conversation():
            if isinstance(event, ProposalVoteResult):
                vote_results.append(event)

    assert len(vote_results) >= 1, "Should have at least one ProposalVoteResult"
    result = vote_results[0]
    summary = result.vote_summary

    assert summary["total_votes"] == 2
    voters = {v["participant"] for v in summary["votes"]}
    assert voters == {"P1", "P2"}


@pytest.mark.asyncio
async def test_parallel_voting_all_accept():
    """When all voters accept in parallel, proposal should be accepted."""
    meeting = _make_meeting(num_participants=4, vote_turn_rule="parallel")
    # P0 proposes, P1/P2/P3 vote accept
    responses = [
        _propose_action(),
        _route_draft(),
        _accept_vote(), _accept_vote(), _accept_vote(),  # 3 voters
        _satisfied_action(), _satisfied_action(), _satisfied_action(), _satisfied_action(),
    ]

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _build_mock_side_effect(responses)

        vote_result = None
        async for event in meeting.run_free_conversation():
            if isinstance(event, ProposalVoteResult):
                vote_result = event
                break

    assert vote_result is not None
    assert vote_result.accepted is True
    assert vote_result.vote_summary["total_votes"] == 3
    assert vote_result.vote_summary["accept_count"] == 3


@pytest.mark.asyncio
async def test_parallel_voting_turn_finals_have_vote_labels():
    """TurnFinal should have steps_label indicating accept/reject."""
    meeting = _make_meeting(num_participants=3, vote_turn_rule="parallel")

    responses = [
        _propose_action(),
        _route_draft(),
        _accept_vote("Looks great!"),
        _reject_vote("Not good enough."),
        _satisfied_action(), _satisfied_action(), _satisfied_action(),
    ]

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _build_mock_side_effect(responses)

        turn_finals = []
        in_voting = False
        async for event in meeting.run_free_conversation():
            if isinstance(event, PhaseMessage) and "Voting" in (event.title or ""):
                in_voting = True
            if isinstance(event, ProposalVoteResult):
                in_voting = False
            if in_voting and isinstance(event, TurnFinal):
                turn_finals.append(event)

    assert len(turn_finals) == 2
    labels = {tf.steps_label for tf in turn_finals}
    assert labels == {"accept", "reject"}, f"Expected accept/reject labels, got {labels}"


@pytest.mark.asyncio
async def test_sequential_voting_still_works():
    """Ensure non-parallel voting (round_robin) still works normally."""
    meeting = _make_meeting(num_participants=3, vote_turn_rule="round_robin")

    responses = [
        _propose_action(),
        _route_draft(),
        _accept_vote(), _accept_vote(),
        _satisfied_action(), _satisfied_action(), _satisfied_action(),
    ]

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _build_mock_side_effect(responses)

        vote_result = None
        async for event in meeting.run_free_conversation():
            if isinstance(event, ProposalVoteResult):
                vote_result = event
                break

    assert vote_result is not None
    assert vote_result.vote_summary["total_votes"] == 2


@pytest.mark.asyncio
async def test_parallel_voting_concurrent_execution():
    """Verify that votes actually execute concurrently, not sequentially."""
    meeting = _make_meeting(num_participants=4, vote_turn_rule="parallel")

    concurrent_count = 0
    max_concurrent = 0
    lock = asyncio.Lock()
    call_idx = 0

    async def mock_acompletion(*args, **kwargs):
        nonlocal call_idx, concurrent_count, max_concurrent
        async with lock:
            call_idx += 1
            current = call_idx

        if current == 1:
            return _make_llm_response(_propose_action())
        if current == 2:
            return _make_llm_response(_route_draft())
        if current <= 5:
            # Voting calls (3, 4, 5) — track concurrency
            async with lock:
                concurrent_count += 1
                if concurrent_count > max_concurrent:
                    max_concurrent = concurrent_count
            await asyncio.sleep(0.01)
            async with lock:
                concurrent_count -= 1
            return _make_llm_response(_accept_vote())
        return _make_llm_response(_satisfied_action())

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = mock_acompletion

        async for event in meeting.run_free_conversation():
            if isinstance(event, ProposalVoteResult):
                break

    assert max_concurrent >= 2, (
        f"Expected concurrent execution (max_concurrent={max_concurrent}), "
        "votes may not be running in parallel"
    )


@pytest.mark.asyncio
async def test_parallel_voting_analytics_records_each_vote():
    """Analytics should record each vote individually with correct turns."""
    meeting = _make_meeting(num_participants=3, vote_turn_rule="parallel")

    responses = [
        _propose_action(),
        _route_draft(),
        _accept_vote(), _accept_vote(),
        _satisfied_action(), _satisfied_action(), _satisfied_action(),
    ]

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _build_mock_side_effect(responses)

        async for event in meeting.run_free_conversation():
            if isinstance(event, MeetingFinished):
                break

    summary = meeting.analytics.get_summary()
    consensus = summary["discussion_dynamics"]["consensus"]

    # Should have 2 approval votes (P1, P2)
    assert consensus["approval"]["total_votes"] == 2
    assert consensus["approval"]["total_approval_votes"] == 2


@pytest.mark.asyncio
async def test_parallel_voting_meeting_completes():
    """Full meeting with parallel voting should reach consensus and finish."""
    meeting = _make_meeting(num_participants=3, vote_turn_rule="parallel")

    responses = [
        _propose_action(),
        _route_draft(),
        _accept_vote(), _accept_vote(),
        _satisfied_action(), _satisfied_action(), _satisfied_action(),
    ]

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _build_mock_side_effect(responses)

        finished = False
        async for event in meeting.run_free_conversation():
            if isinstance(event, MeetingFinished):
                finished = True

    assert finished, "Meeting should have finished"

    summary = meeting.analytics.get_summary()
    assert summary["termination_reason"] == "consensus"

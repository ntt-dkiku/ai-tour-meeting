"""Tests for stopping a meeting while the human participant holds a turn.

Covers:
- Stop during the human's speaking turn ends the run without recording an
  empty message
- Stop during the human's vote turn unblocks the vote wait (regression: the
  vote queue was never unblocked, leaving the meeting stuck in "stopping")
- stop() sentinels left in the human queues do not leak into the next run
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tour_meeting.cli import build_meeting
from tour_meeting.types import AskExchange, HumanAsk, HumanTurn, HumanVote, TurnFinal

pytestmark = pytest.mark.asyncio(loop_scope="function")

RUN_TIMEOUT = 10.0


def _participant(name: str) -> Dict[str, Any]:
    return {
        "name": name,
        "model_name": "test/mock",
        "background": f"{name} is a test participant.",
        "personality": "Curious.",
        "preferences": "Efficient discussions.",
        "personal_goals": "Test goals.",
        "role": "attendee",
        "temperature": 0.0,
        "max_steps": 1,
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


def _build_meeting(order: List[str]):
    meeting = build_meeting(
        title="Stop Test",
        global_goals="Plan a test tour.",
        participants=[_participant("P0")],
        settings={
            "turn_rule": "round_robin",
            "voting_rule": "majority",
            "max_turns": 10,
            "balanced_turns": True,
        },
    )
    meeting.enable_human(name="You")
    meeting.set_order(order)
    return meeting


async def test_stop_during_human_speaking_turn_ends_run_without_empty_message():
    meeting = _build_meeting(["__YOU__", "P0"])

    async def drive():
        events = []
        async for event in meeting.run_free_conversation():
            events.append(event)
            if isinstance(event, HumanTurn):
                meeting.stop()
        return events

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect([])
        events = await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    human_finals = [e for e in events if isinstance(e, TurnFinal) and e.speaker == "You"]
    assert human_finals == [], "the stop sentinel must not be recorded as a spoken turn"
    assert all(
        (getattr(m, "content", "") or "").strip() for m in meeting.history
    ), "no empty message should be appended to history on stop"


async def test_stop_during_human_vote_unblocks_the_run():
    """Regression: stop() never unblocked the human vote wait, so the meeting
    stayed in 'stopping' forever when stopped during the human's vote turn."""
    meeting = _build_meeting(["P0", "__YOU__"])
    responses = [
        json.dumps({"action": "propose", "message": "Let me propose a route."}),
        json.dumps({"message": "Here's my route proposal.", "route": _ROUTE_JSON}),
    ]

    saw_vote = False

    async def drive():
        nonlocal saw_vote
        async for event in meeting.run_free_conversation():
            if isinstance(event, HumanVote):
                saw_vote = True
                meeting.stop()

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect(responses)
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    assert saw_vote, "the human should have been asked to vote"
    votes = meeting.analytics.get_summary()["discussion_dynamics"]["consensus"]
    assert votes["approval"]["total_votes"] == 0, "the stop sentinel must not count as a vote"


async def test_stale_stop_sentinels_do_not_leak_into_next_run():
    """A stop() with no active human wait leaves sentinels in the queues; a new
    run must drain them instead of consuming them as instant input."""
    meeting = _build_meeting(["__YOU__", "P0"])
    meeting.stop()  # fills the human queues with unblock sentinels

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect([])
        stream = meeting.run_free_conversation()
        try:
            # Advance to the human's turn, then answer it. Without the drain, a
            # stale "" sentinel would be consumed before our real message and
            # the turn would finalize with empty text.
            while True:
                event = await asyncio.wait_for(stream.__anext__(), timeout=RUN_TIMEOUT)
                if isinstance(event, HumanTurn):
                    break

            meeting.submit_human("hello there")
            while True:
                event = await asyncio.wait_for(stream.__anext__(), timeout=RUN_TIMEOUT)
                if isinstance(event, TurnFinal) and event.speaker == "You":
                    break
            assert event.text == "hello there"
        finally:
            meeting.stop()
            await stream.aclose()


async def test_stop_during_human_ask_aborts_askers_turn():
    """Stopping while an LLM waits on the human's answer must abort the asker's
    turn — not record a '(No response.)' exchange and move to the next speaker."""
    meeting = _build_meeting(["P0", "__YOU__"])
    responses = [
        json.dumps({"action": "ask", "ask_target": "You", "message": "What's your budget?"}),
    ]

    events = []

    async def drive():
        async for event in meeting.run_free_conversation():
            events.append(event)
            if isinstance(event, HumanAsk):
                meeting.stop()

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect(responses)
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    assert any(isinstance(e, HumanAsk) for e in events), "the ask should reach the human"
    assert not any(isinstance(e, AskExchange) for e in events), (
        "no '(No response.)' exchange should be recorded on stop"
    )
    assert not any(isinstance(e, TurnFinal) and e.speaker == "P0" for e in events), (
        "the asker's turn must be aborted, not completed"
    )


async def test_reset_meeting_cancels_live_run_task(tmp_path, monkeypatch):
    """Regression: reset used to swap out the stop event under a running task,
    orphaning it — the meeting kept running forever with status 'idle'."""
    from tour_meeting.backend import api

    store = api.MeetingStore(storage_path=tmp_path / "meetings_test.json")
    meeting_id = store.create_meeting("reset-cancel")
    monkeypatch.setattr(api, "STORE", store)
    runtime = store._ensure_runtime(meeting_id, "goal", 10, None)

    started = asyncio.Event()

    async def fake_run():
        started.set()
        await asyncio.sleep(60)

    runtime.task = asyncio.create_task(fake_run())
    await started.wait()

    await asyncio.wait_for(api.reset_meeting(meeting_id), timeout=RUN_TIMEOUT)
    assert runtime.task.done(), "reset must terminate the live run task"

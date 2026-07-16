"""Resuming a stopped meeting must continue GUI turn numbering.

GUI events are keyed by (turn, speaker). Before the fix, a resumed
run_free_conversation reset its turn counter to 0, so resumed turns reused
old numbers and the frontend merged them into existing chat entries instead
of appending new ones ("no new messages appear after Resume").
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tour_meeting.cli import build_meeting
from tour_meeting.messages import AIMessage, HumanMessage
from tour_meeting.types import TurnStart

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


def _build_meeting():
    return build_meeting(
        title="Resume",
        global_goals="Plan a test tour.",
        participants=[_participant("P0")],
        settings={
            "turn_rule": "round_robin",
            "voting_rule": "majority",
            "max_turns": 10,
            "balanced_turns": True,
        },
    )


async def test_resume_continues_turn_numbering_from_history():
    meeting = _build_meeting()
    meeting.history = [
        HumanMessage(content="Plan a test tour.", name="MeetingGoal"),
        AIMessage(
            content="[Steps]\n[Step 1/1 - discussion]\nAn earlier turn.",
            name="P0",
            additional_kwargs={"turn": 7},
        ),
    ]

    first_turn = None

    async def drive():
        nonlocal first_turn
        async for event in meeting.run_free_conversation(resume_from_history=True):
            if isinstance(event, TurnStart):
                first_turn = event.turn
                break

    satisfied = json.dumps({"action": "satisfied", "message": "done"})
    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.return_value = _make_llm_response(satisfied)
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    # The restored history's highest turn is 7, so the resumed run's first
    # turn must be 8 — not 1, which would collide with the existing entry.
    assert first_turn == 8
    # The prior history survived the resume.
    assert any(getattr(m, "name", "") == "P0" for m in meeting.history)


async def test_fresh_start_still_begins_at_turn_one():
    meeting = _build_meeting()

    first_turn = None

    async def drive():
        nonlocal first_turn
        async for event in meeting.run_free_conversation():
            if isinstance(event, TurnStart):
                first_turn = event.turn
                break

    satisfied = json.dumps({"action": "satisfied", "message": "done"})
    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.return_value = _make_llm_response(satisfied)
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    assert first_turn == 1

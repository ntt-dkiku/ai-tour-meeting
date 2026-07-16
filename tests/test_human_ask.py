"""Tests for LLM participants asking the human participant.

Covers:
- The human's display name (not "__YOU__") is offered to the LLM as an askable
  participant
- An "ask" targeting the human surfaces a HumanAsk event and the human's typed
  answer is fed back as the ask response
- The human's answer appears in the resulting AskExchange
"""

from __future__ import annotations

import json
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tour_meeting.cli import build_meeting
from tour_meeting.types import HumanAsk, AskExchange

pytestmark = pytest.mark.asyncio(loop_scope="function")


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


def _side_effect(responses):
    idx = 0

    async def se(*args, **kwargs):
        nonlocal idx
        content = responses[idx] if idx < len(responses) else json.dumps(
            {"action": "satisfied", "message": "done"}
        )
        idx += 1
        return _make_llm_response(content)

    return se


def _build_meeting(human_name: str = "You"):
    meeting = build_meeting(
        title="Ask Human",
        global_goals="Plan a test tour.",
        participants=[_participant("P0")],
        settings={
            "turn_rule": "round_robin",
            "voting_rule": "majority",
            "max_turns": 10,
            "balanced_turns": True,
        },
    )
    meeting.enable_human(name=human_name)
    meeting.set_order(["P0", "__YOU__"])
    return meeting


async def test_llm_ask_targets_human_and_gets_answer():
    meeting = _build_meeting()
    responses = [
        json.dumps({"action": "ask", "ask_target": "You", "message": "What's your budget?"}),
        json.dumps({"action": "satisfied", "message": "Thanks!"}),
    ]

    saw_human_ask = False
    ask_exchange = None
    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect(responses)
        async for event in meeting.run_free_conversation():
            if isinstance(event, HumanAsk):
                saw_human_ask = True
                assert event.asker == "P0"
                assert event.target == "You"
                assert "budget" in event.question.lower()
                meeting.submit_human_ask_answer("My budget is $100.")
            elif isinstance(event, AskExchange):
                ask_exchange = event
                break

    assert saw_human_ask, "an ask targeting the human should raise HumanAsk"
    assert ask_exchange is not None
    assert ask_exchange.target == "You"
    assert ask_exchange.response == "My budget is $100."


async def test_llm_sees_custom_human_name_as_ask_target():
    """A renamed human is askable by their display name, not the __YOU__ token."""
    meeting = _build_meeting(human_name="Daisuke")
    responses = [
        json.dumps({"action": "ask", "ask_target": "Daisuke", "message": "Any constraints?"}),
        json.dumps({"action": "satisfied", "message": "Great."}),
    ]

    ask_exchange = None
    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect(responses)
        async for event in meeting.run_free_conversation():
            if isinstance(event, HumanAsk):
                assert event.target == "Daisuke"
                meeting.submit_human_ask_answer("No constraints.")
            elif isinstance(event, AskExchange):
                ask_exchange = event
                break

    assert ask_exchange is not None
    assert ask_exchange.target == "Daisuke"
    assert ask_exchange.response == "No constraints."


async def test_is_human_ask_target_matches_name_variants():
    meeting = _build_meeting(human_name="Jane Doe")
    assert meeting._is_human_ask_target("__YOU__") is True
    assert meeting._is_human_ask_target("Jane Doe") is True
    assert meeting._is_human_ask_target("Jane_Doe") is True  # sanitized form
    assert meeting._is_human_ask_target("P0") is False

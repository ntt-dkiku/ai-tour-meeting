"""Tests for the human-as-facilitator turn selection.

Covers:
- create_selector detecting the human facilitator (vs an LLM facilitator)
- FacilitatingSelector.candidates()/record_choice() eligibility logic
- run_free_conversation prompting the human (HumanSelectSpeaker) and honoring
  the submitted pick
"""

from __future__ import annotations

import json
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tour_meeting.cli import build_meeting
from tour_meeting.turn_selector import create_selector, FacilitatingSelector
from tour_meeting.types import HumanSelectSpeaker, TurnStart, PhaseMessage


class _FakeParticipant:
    def __init__(self, name: str, role: str = "attendee"):
        self.name = name
        self.role = role


def _selector(order, *, human_key=None, lookup=None):
    return create_selector(
        turn_rule="facilitating",
        order=order,
        satisfied_tracker={n: False for n in order},
        participant_lookup=lookup or {},
        human_facilitator_key=human_key,
    )


def test_create_selector_detects_human_facilitator():
    order = ["Amina", "Bao", "__YOU__"]
    lookup = {"Amina": _FakeParticipant("Amina"), "Bao": _FakeParticipant("Bao")}
    sel = _selector(order, human_key="__YOU__", lookup=lookup)
    assert isinstance(sel, FacilitatingSelector)
    assert sel.facilitator_is_human is True


def test_create_selector_llm_facilitator_when_no_human_key():
    order = ["Amina", "Bao"]
    lookup = {
        "Amina": _FakeParticipant("Amina", role="facilitator"),
        "Bao": _FakeParticipant("Bao"),
    }
    sel = _selector(order, human_key=None, lookup=lookup)
    assert isinstance(sel, FacilitatingSelector)
    assert sel.facilitator_is_human is False
    assert sel._facilitator_name == "Amina"


def test_human_facilitator_candidates_include_self_and_exclude_repeats():
    order = ["Amina", "Bao", "__YOU__"]
    lookup = {"Amina": _FakeParticipant("Amina"), "Bao": _FakeParticipant("Bao")}
    sel = _selector(order, human_key="__YOU__", lookup=lookup)
    sel.start_round()

    # The human (facilitator) can pick anyone, including themselves.
    assert set(sel.candidates()) == {"Amina", "Bao", "__YOU__"}

    # After a pick + completed turn, that speaker drops out this round and the
    # last pick is not offered back-to-back.
    sel.record_choice("Amina")
    sel.on_turn_complete("Amina", "discussion", {})
    assert "Amina" not in sel.candidates()
    assert set(sel.candidates()) == {"Bao", "__YOU__"}


def test_human_facilitator_candidates_empty_when_round_exhausted():
    order = ["Amina", "__YOU__"]
    lookup = {"Amina": _FakeParticipant("Amina")}
    sel = _selector(order, human_key="__YOU__", lookup=lookup)
    sel.start_round()
    for n in order:
        sel.record_choice(n)
        sel.on_turn_complete(n, "discussion", {})
    assert sel.candidates() == []


# ── Run-loop integration ────────────────────────────────────────────


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


@pytest.mark.asyncio
async def test_human_facilitator_pick_drives_next_speaker():
    """The run loop prompts the human facilitator and the chosen LLM speaks."""
    meeting = build_meeting(
        title="Facilitated Meeting",
        global_goals="Plan a test tour.",
        participants=[_participant("P0"), _participant("P1")],
        settings={
            "turn_rule": "facilitating",
            "voting_rule": "majority",
            "max_turns": 30,
            "balanced_turns": True,
        },
    )
    meeting.enable_human(name="You")
    meeting.set_order(["P0", "P1", "__YOU__"])

    async def _benign_llm(*args, **kwargs):
        return _make_llm_response(json.dumps({"action": "satisfied", "message": "ok"}))

    select_events = []
    saw_turnstart_for_pick = False
    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _benign_llm
        async for event in meeting.run_free_conversation(human_role="facilitator"):
            if isinstance(event, HumanSelectSpeaker):
                select_events.append(event)
                # The human can pick anyone in the order, including themselves.
                assert set(event.candidates) == {"P0", "P1", "__YOU__"}
                meeting.submit_human_selection("P1")
            elif isinstance(event, TurnStart) and event.speaker == "P1":
                saw_turnstart_for_pick = True
                break

    assert select_events, "expected a HumanSelectSpeaker prompt"
    assert saw_turnstart_for_pick, "the picked participant (P1) should take the turn"


@pytest.mark.asyncio
async def test_human_facilitator_emits_invite_phase_marker():
    meeting = build_meeting(
        title="Facilitated Meeting",
        global_goals="Plan a test tour.",
        participants=[_participant("P0"), _participant("P1")],
        settings={
            "turn_rule": "facilitating",
            "voting_rule": "majority",
            "max_turns": 30,
            "balanced_turns": True,
        },
    )
    meeting.enable_human(name="You")
    meeting.set_order(["P0", "P1", "__YOU__"])

    async def _benign_llm(*args, **kwargs):
        return _make_llm_response(json.dumps({"action": "satisfied", "message": "ok"}))

    invite_markers = []
    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _benign_llm
        async for event in meeting.run_free_conversation(human_role="facilitator"):
            if isinstance(event, HumanSelectSpeaker):
                meeting.submit_human_selection("P0")
            elif isinstance(event, PhaseMessage) and event.title == "Facilitator Selected Next Speaker":
                invite_markers.append(event)
            elif isinstance(event, TurnStart) and event.speaker == "P0":
                break

    assert invite_markers, "expected a facilitator invite phase marker"
    assert "invited P0" in (invite_markers[0].description or "")

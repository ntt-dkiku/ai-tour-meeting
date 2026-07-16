"""Tests for per-participant system-prompt override.

Covers the full Python wiring: ``safe_format`` substitution, ``build_messages``
robustness to literal braces, ``Participant`` template selection, ``build_meeting``
pass-through, and config validation.
"""

from __future__ import annotations

import pytest

from tour_meeting.cli import build_meeting, _validate_participant
from tour_meeting.llm import LLMConfig, build_messages, safe_format
from tour_meeting.messages import HumanMessage
from tour_meeting.participant import Participant, SYS_PARTICIPANT


def _participant(**overrides):
    base = {
        "name": "Alice",
        "model_name": "openai/gpt-4",
        "background": "A software engineer visiting from abroad.",
        "personality": "Curious and detail-oriented.",
        "preferences": "Prefers quiet, historical sites over crowds.",
        "personal_goals": "Visit museums.",
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# safe_format
# ---------------------------------------------------------------------------

class TestSafeFormat:

    def test_substitutes_known_keys(self):
        out = safe_format("Hi {name}, goal={goal}.", {"name": "Bob", "goal": "Tokyo"})
        assert out == "Hi Bob, goal=Tokyo."

    def test_leaves_unknown_placeholders_intact(self):
        out = safe_format("{name} and {unknown}", {"name": "Bob"})
        assert out == "Bob and {unknown}"

    def test_preserves_literal_json_braces(self):
        out = safe_format('Reply as JSON {"k": 1} for {name}', {"name": "Bob"})
        assert out == 'Reply as JSON {"k": 1} for Bob'

    def test_does_not_raise_on_missing_keys(self):
        # str.format would raise KeyError here; safe_format must not.
        assert safe_format("{a}{b}{c}", {"a": "1"}) == "1{b}{c}"


# ---------------------------------------------------------------------------
# build_messages with a custom system template
# ---------------------------------------------------------------------------

class TestBuildMessages:

    def test_custom_system_template_with_literal_braces(self):
        msgs = build_messages(
            system_template='You are {name}. Output JSON {"a": 1}. Ignore {missing}.',
            history=[HumanMessage(content="prev")],
            payload={"name": "Bob"},
            format_instructions="FMT",
            human_template="Act now. {format_instructions}",
        )
        assert msgs[0]["role"] == "system"
        assert msgs[0]["content"] == 'You are Bob. Output JSON {"a": 1}. Ignore {missing}.'
        assert msgs[-1]["content"] == "Act now. FMT"


# ---------------------------------------------------------------------------
# Participant template selection
# ---------------------------------------------------------------------------

class TestParticipantTemplate:

    def _make(self, **kw):
        cfg = LLMConfig(model="openai/dummy", temperature=0.7)
        return Participant(
            llm=cfg, name="P", background="x", personality="y", preferences="z",
            personal_goals="y", **kw,
        )

    def test_override_used_when_set(self):
        p = self._make(system_prompt="CUSTOM {name} PROMPT")
        assert p.system_prompt_template == "CUSTOM {name} PROMPT"

    def test_default_when_omitted(self):
        p = self._make()
        assert p.system_prompt_template is SYS_PARTICIPANT
        assert p.system_prompt is None

    @pytest.mark.parametrize("blank", [None, "", "   ", "\n\t"])
    def test_blank_override_falls_back_to_default(self, blank):
        p = self._make(system_prompt=blank)
        assert p.system_prompt_template is SYS_PARTICIPANT


# ---------------------------------------------------------------------------
# build_meeting pass-through
# ---------------------------------------------------------------------------

class TestBuildMeeting:

    def test_per_participant_override(self):
        meeting = build_meeting(
            title="T",
            global_goals="G",
            participants=[
                _participant(name="Alice", system_prompt="I am {name}."),
                _participant(name="Bob"),
            ],
        )
        by_name = {p.name: p for p in meeting.participants}
        assert by_name["Alice"].system_prompt_template == "I am {name}."
        assert by_name["Bob"].system_prompt_template is SYS_PARTICIPANT


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------

class TestValidation:

    def test_string_override_accepted(self):
        _validate_participant(0, _participant(system_prompt="custom"))  # no raise

    def test_none_override_accepted(self):
        _validate_participant(0, _participant(system_prompt=None))  # no raise

    @pytest.mark.parametrize("bad", [123, 1.5, ["a"], {"x": 1}, True])
    def test_non_string_override_rejected(self, bad):
        with pytest.raises(ValueError, match="system_prompt must be a string"):
            _validate_participant(0, _participant(system_prompt=bad))

"""Tests for cli module (build_meeting validation)."""

from __future__ import annotations

import warnings

import pytest

from tour_meeting.cli import build_meeting, _validate_participant


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _valid_participant(**overrides):
    """Return a minimal valid participant config dict."""
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
# _validate_participant – required keys
# ---------------------------------------------------------------------------

_REQUIRED_KEYS = ["name", "model_name", "background", "personality", "preferences", "personal_goals"]


class TestRequiredKeys:

    def test_all_required_keys_present(self):
        _validate_participant(0, _valid_participant())  # should not raise

    @pytest.mark.parametrize("missing_key", _REQUIRED_KEYS)
    def test_missing_required_key(self, missing_key):
        cfg = _valid_participant()
        del cfg[missing_key]
        with pytest.raises(ValueError, match="missing required keys"):
            _validate_participant(0, cfg)

    @pytest.mark.parametrize("key", _REQUIRED_KEYS)
    def test_empty_string_required_key(self, key):
        cfg = _valid_participant(**{key: ""})
        with pytest.raises(ValueError, match="non-empty string"):
            _validate_participant(0, cfg)

    @pytest.mark.parametrize("key", _REQUIRED_KEYS)
    def test_whitespace_only_required_key(self, key):
        cfg = _valid_participant(**{key: "   "})
        with pytest.raises(ValueError, match="non-empty string"):
            _validate_participant(0, cfg)

    @pytest.mark.parametrize("key", _REQUIRED_KEYS)
    def test_non_string_required_key(self, key):
        cfg = _valid_participant(**{key: 123})
        with pytest.raises(ValueError, match="non-empty string"):
            _validate_participant(0, cfg)


# ---------------------------------------------------------------------------
# _validate_participant – enum values
# ---------------------------------------------------------------------------

class TestEnumValues:

    @pytest.mark.parametrize("role", ["facilitator", "attendee"])
    def test_valid_role(self, role):
        _validate_participant(0, _valid_participant(role=role))

    def test_invalid_role(self):
        with pytest.raises(ValueError, match="invalid role"):
            _validate_participant(0, _valid_participant(role="moderator"))

    @pytest.mark.parametrize("style", ["auto", "subjective", "contrastive", "both"])
    def test_valid_explanation_style(self, style):
        _validate_participant(0, _valid_participant(explanation_style=style))

    def test_invalid_explanation_style(self):
        with pytest.raises(ValueError, match="invalid explanation_style"):
            _validate_participant(0, _valid_participant(explanation_style="none"))

    @pytest.mark.parametrize("mode", ["auto_compact", "truncate", "fixed_turns", "none"])
    def test_valid_context_mode(self, mode):
        _validate_participant(0, _valid_participant(context_mode=mode))

    def test_invalid_context_mode(self):
        with pytest.raises(ValueError, match="invalid context_mode"):
            _validate_participant(0, _valid_participant(context_mode="unlimited"))


# ---------------------------------------------------------------------------
# _validate_participant – speaking_style (free-form string)
# ---------------------------------------------------------------------------

class TestSpeakingStyle:

    @pytest.mark.parametrize("style", ["friendly", "enthusiastic", "supportive", "custom style"])
    def test_valid_speaking_style(self, style):
        _validate_participant(0, _valid_participant(speaking_style=style))

    def test_empty_speaking_style(self):
        with pytest.raises(ValueError, match="speaking_style must be a non-empty string"):
            _validate_participant(0, _valid_participant(speaking_style=""))

    def test_non_string_speaking_style(self):
        with pytest.raises(ValueError, match="speaking_style must be a non-empty string"):
            _validate_participant(0, _valid_participant(speaking_style=42))


# ---------------------------------------------------------------------------
# _validate_participant – numeric values
# ---------------------------------------------------------------------------

class TestNumericValues:

    def test_valid_temperature(self):
        _validate_participant(0, _valid_participant(temperature=0.7))

    def test_zero_temperature(self):
        _validate_participant(0, _valid_participant(temperature=0))

    def test_negative_temperature(self):
        with pytest.raises(ValueError, match="temperature must be a non-negative number"):
            _validate_participant(0, _valid_participant(temperature=-0.1))

    def test_non_numeric_temperature(self):
        with pytest.raises(ValueError, match="temperature must be a non-negative number"):
            _validate_participant(0, _valid_participant(temperature="high"))

    def test_valid_max_steps(self):
        _validate_participant(0, _valid_participant(max_steps=3))

    def test_zero_max_steps(self):
        with pytest.raises(ValueError, match="max_steps must be a positive integer"):
            _validate_participant(0, _valid_participant(max_steps=0))

    def test_float_max_steps(self):
        with pytest.raises(ValueError, match="max_steps must be a positive integer"):
            _validate_participant(0, _valid_participant(max_steps=2.5))

    def test_valid_seed(self):
        _validate_participant(0, _valid_participant(seed=42))

    def test_non_int_seed(self):
        with pytest.raises(ValueError, match="seed must be an integer"):
            _validate_participant(0, _valid_participant(seed=3.14))

    @pytest.mark.parametrize("key", [
        "auto_compact_threshold", "auto_compact_target", "compact_recent_ratio",
    ])
    def test_valid_ratio(self, key):
        _validate_participant(0, _valid_participant(**{key: 0.5}))

    @pytest.mark.parametrize("key", [
        "auto_compact_threshold", "auto_compact_target", "compact_recent_ratio",
    ])
    def test_ratio_boundary_zero(self, key):
        _validate_participant(0, _valid_participant(**{key: 0}))

    @pytest.mark.parametrize("key", [
        "auto_compact_threshold", "auto_compact_target", "compact_recent_ratio",
    ])
    def test_ratio_boundary_one(self, key):
        _validate_participant(0, _valid_participant(**{key: 1}))

    @pytest.mark.parametrize("key", [
        "auto_compact_threshold", "auto_compact_target", "compact_recent_ratio",
    ])
    def test_ratio_above_one(self, key):
        with pytest.raises(ValueError, match=f"{key} must be a number between 0 and 1"):
            _validate_participant(0, _valid_participant(**{key: 1.5}))

    @pytest.mark.parametrize("key", [
        "auto_compact_threshold", "auto_compact_target", "compact_recent_ratio",
    ])
    def test_ratio_below_zero(self, key):
        with pytest.raises(ValueError, match=f"{key} must be a number between 0 and 1"):
            _validate_participant(0, _valid_participant(**{key: -0.1}))


# ---------------------------------------------------------------------------
# _validate_participant – unknown keys warning
# ---------------------------------------------------------------------------

class TestUnknownKeys:

    def test_unknown_key_warns(self):
        cfg = _valid_participant(typo_key="oops")
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            _validate_participant(0, cfg)
            assert len(w) == 1
            assert "unknown keys ignored" in str(w[0].message)
            assert "typo_key" in str(w[0].message)


# ---------------------------------------------------------------------------
# build_meeting – integration
# ---------------------------------------------------------------------------

class TestBuildMeeting:

    def test_empty_participants_raises(self):
        with pytest.raises(ValueError, match="participants list must not be empty"):
            build_meeting("Title", "Goal", [])

    def test_valid_build(self):
        meeting = build_meeting(
            title="Test Tour",
            global_goals="Plan a tour.",
            participants=[_valid_participant()],
        )
        assert len(meeting.participants) == 1
        assert meeting.participants[0].name == "Alice"
        assert meeting._title == "Test Tour"

    def test_multiple_participants(self):
        participants = [
            _valid_participant(name="Alice"),
            _valid_participant(name="Bob", role="facilitator"),
        ]
        meeting = build_meeting("Tour", "Goal", participants)
        assert len(meeting.participants) == 2
        assert meeting.participants[1].role == "facilitator"

    def test_constraints_and_settings_passed(self):
        constraints = {"budget": "$500"}
        settings = {"max_turns": 10, "turn_rule": "round_robin"}
        meeting = build_meeting(
            "Tour", "Goal",
            [_valid_participant()],
            constraints=constraints,
            settings=settings,
        )
        assert meeting._constraints == constraints
        assert meeting._settings["max_turns"] == 10

    def test_invalid_participant_stops_build(self):
        participants = [
            _valid_participant(name="Alice"),
            _valid_participant(name="Bob", temperature=-1),
        ]
        with pytest.raises(ValueError, match="Bob.*temperature"):
            build_meeting("Tour", "Goal", participants)

    def test_optional_params_applied(self):
        cfg = _valid_participant(
            temperature=0.9,
            max_steps=3,
            context_mode="truncate",
            speaking_style="enthusiastic",
        )
        meeting = build_meeting("Tour", "Goal", [cfg])
        p = meeting.participants[0]
        assert p.llm.temperature == 0.9
        assert p.max_steps == 3
        assert p.context_mode == "truncate"
        assert p.speaking_style == "enthusiastic"

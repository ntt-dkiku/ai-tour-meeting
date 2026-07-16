"""Validation tests for backend ParticipantIn settings."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from tour_meeting.backend.api import ParticipantIn


def _base_payload() -> dict:
    return {
        "model_name": "openai/gpt-4o-mini-2024-07-18",
        "temperature": 0.7,
        "seed": 42,
        "name": "Test User",
        "background": "test background",
        "personality": "test personality",
        "preferences": "test preferences",
        "personal_goals": "test goals",
        "role": "attendee",
        "speaking_style": "friendly",
        "explanation_style": "auto",
    }


def test_context_mode_rejects_unknown_value():
    payload = _base_payload()
    payload["context_mode"] = "invalid_mode"

    with pytest.raises(ValidationError):
        ParticipantIn(**payload)


def test_auto_compact_target_must_be_smaller_than_threshold():
    payload = _base_payload()
    payload["auto_compact_target"] = 0.8
    payload["auto_compact_threshold"] = 0.8

    with pytest.raises(ValidationError):
        ParticipantIn(**payload)


def test_compact_recent_ratio_must_be_between_zero_and_one():
    payload = _base_payload()
    payload["compact_recent_ratio"] = 1.0

    with pytest.raises(ValidationError):
        ParticipantIn(**payload)


def test_fixed_turns_count_must_be_positive():
    payload = _base_payload()
    payload["fixed_turns_count"] = 0

    with pytest.raises(ValidationError):
        ParticipantIn(**payload)

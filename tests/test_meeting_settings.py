"""Tests for conversation/vote settings persistence and consistency."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from tour_meeting.backend import api
from tour_meeting.types import MeetingFinished


def _create_store(tmp_path: Path) -> api.MeetingStore:
    return api.MeetingStore(storage_path=tmp_path / "meetings_test.json")


def _pin(name: str, role: str = "attendee", **overrides) -> api.ParticipantIn:
    base = dict(
        model_name="test/mock",
        temperature=0.0,
        seed=42,
        name=name,
        background="b",
        personality="p",
        preferences="pr",
        personal_goals="g",
        role=role,
        speaking_style="friendly",
        explanation_style="auto",
    )
    base.update(overrides)
    return api.ParticipantIn(**base)


def test_store_persists_vote_settings_fields(tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("settings")
    info = store.get_meeting_info(meeting_id)
    assert info is not None

    info["vote_settings_linked"] = False
    info["vote_turn_rule"] = "facilitating"
    store.save()

    reloaded = api.MeetingStore(storage_path=tmp_path / "meetings_test.json")
    loaded = reloaded.get_meeting_info(meeting_id)
    assert loaded is not None
    assert loaded.get("vote_settings_linked") is False
    assert loaded.get("vote_turn_rule") == "facilitating"


def test_list_meetings_includes_vote_settings_fields(tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("list")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["vote_settings_linked"] = False
    info["vote_turn_rule"] = "random"
    store.save()

    meetings = store.list_meetings()
    item = next(m for m in meetings if m["id"] == meeting_id)
    assert item["vote_settings_linked"] is False
    assert item["vote_turn_rule"] == "random"


def test_update_meeting_rejects_vote_turn_rule_when_linked(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("patch")
    monkeypatch.setattr(api, "STORE", store)

    with pytest.raises(HTTPException) as exc:
        api.update_meeting(
            meeting_id,
            api.MeetingUpdate(vote_settings_linked=True, vote_turn_rule="random"),
        )
    assert exc.value.status_code == 400
    assert "vote_turn_rule" in str(exc.value.detail)


def test_update_meeting_accepts_vote_turn_rule_when_unlinked(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("patch-ok")
    monkeypatch.setattr(api, "STORE", store)

    result = api.update_meeting(
        meeting_id,
        api.MeetingUpdate(vote_settings_linked=False, vote_turn_rule="random"),
    )
    assert result["vote_settings_linked"] is False
    assert result["vote_turn_rule"] == "random"


def test_update_meeting_accepts_unanimous_voting_rule(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("patch-unanimous")
    monkeypatch.setattr(api, "STORE", store)

    result = api.update_meeting(
        meeting_id,
        api.MeetingUpdate(initialization_voting_rule="unanimous"),
    )
    assert result["initialization_voting_rule"] == "unanimous"


def test_update_meeting_rejects_unknown_single_decider(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("decider-invalid")
    monkeypatch.setattr(api, "STORE", store)

    with pytest.raises(HTTPException) as exc:
        api.update_meeting(
            meeting_id,
            api.MeetingUpdate(single_decider="no-such-id"),
        )
    assert exc.value.status_code == 400
    assert "single_decider" in str(exc.value.detail)


def test_update_meeting_accepts_and_clears_single_decider(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("decider-ok")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["participants_config"] = [{"id": "abc123", "name": "Alice", "engine_name": "Alice"}]
    monkeypatch.setattr(api, "STORE", store)

    result = api.update_meeting(
        meeting_id,
        api.MeetingUpdate(initialization_voting_rule="single_decider", single_decider="abc123"),
    )
    assert result["single_decider"] == "abc123"

    result = api.update_meeting(meeting_id, api.MeetingUpdate(single_decider=None))
    assert result["single_decider"] is None


def test_update_meeting_accepts_human_single_decider(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("decider-human")
    monkeypatch.setattr(api, "STORE", store)

    api.update_meeting(meeting_id, api.MeetingUpdate(include_human=True))
    result = api.update_meeting(meeting_id, api.MeetingUpdate(single_decider="__YOU__"))
    assert result["single_decider"] == "__YOU__"

    # Turning the human off clears the human decider.
    result = api.update_meeting(meeting_id, api.MeetingUpdate(include_human=False))
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    assert info.get("single_decider") is None


def test_store_persists_single_decider(tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("decider-persist")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["single_decider"] = "some-id"
    store.save()

    reloaded = api.MeetingStore(storage_path=tmp_path / "meetings_test.json")
    loaded = reloaded.get_meeting_info(meeting_id)
    assert loaded is not None
    assert loaded.get("single_decider") == "some-id"


def test_delete_participant_clears_single_decider(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("decider-delete")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["participants_config"] = [{"id": "abc123", "name": "Alice", "engine_name": "Alice"}]
    info["single_decider"] = "abc123"
    monkeypatch.setattr(api, "STORE", store)

    api.delete_participant(meeting_id, "abc123")
    assert info.get("single_decider") is None


def test_update_meeting_sets_human_name_and_avatar(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("human-profile")
    monkeypatch.setattr(api, "STORE", store)

    avatar = {"kind": "generated", "shape": "circle", "palette": 2, "face": 1}
    result = api.update_meeting(
        meeting_id,
        api.MeetingUpdate(include_human=True, human_name="Daisuke", human_avatar=avatar),
    )
    assert result["human_name"] == "Daisuke"
    assert result["human_avatar"] == avatar

    # The engine-side human name follows immediately when the human is enabled.
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    assert info["meeting"]._human_name == "Daisuke"

    reloaded = api.MeetingStore(storage_path=tmp_path / "meetings_test.json")
    loaded = reloaded.get_meeting_info(meeting_id)
    assert loaded is not None
    assert loaded.get("human_name") == "Daisuke"
    assert loaded.get("human_avatar") == avatar


def test_update_meeting_sets_and_validates_human_role(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("human-role")
    monkeypatch.setattr(api, "STORE", store)

    result = api.update_meeting(meeting_id, api.MeetingUpdate(human_role="facilitator"))
    assert result["human_role"] == "facilitator"

    with pytest.raises(HTTPException) as exc:
        api.update_meeting(meeting_id, api.MeetingUpdate(human_role="observer"))
    assert exc.value.status_code == 400

    reloaded = api.MeetingStore(storage_path=tmp_path / "meetings_test.json")
    loaded = reloaded.get_meeting_info(meeting_id)
    assert loaded is not None
    assert loaded.get("human_role") == "facilitator"


def test_add_second_facilitator_is_allowed(monkeypatch, tmp_path: Path):
    """The backend no longer rejects a 2nd facilitator; the UI warns and blocks Start."""
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("facil-allowed")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["participants_config"] = [
        {"id": "aaa", "name": "Alice", "engine_name": "Alice", "role": "facilitator"}
    ]
    monkeypatch.setattr(api, "STORE", store)

    result = api.add_participant(meeting_id, _pin("Bob", role="facilitator"))
    assert result["ok"] is True
    roles = [c["role"] for c in info["participants_config"]]
    assert roles.count("facilitator") == 2


def test_human_facilitator_alongside_llm_facilitator_is_allowed(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("facil-human-allowed")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["participants_config"] = [
        {"id": "aaa", "name": "Alice", "engine_name": "Alice", "role": "facilitator"}
    ]
    monkeypatch.setattr(api, "STORE", store)

    result = api.update_meeting(
        meeting_id, api.MeetingUpdate(include_human=True, human_role="facilitator")
    )
    assert result["human_role"] == "facilitator"


def test_duplicate_keeps_facilitator_role(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("facil-dup")
    monkeypatch.setattr(api, "STORE", store)

    api.add_participant(meeting_id, _pin("Alice", role="facilitator"))
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    src_id = info["participants_config"][0]["id"]

    out = api.duplicate_participant(meeting_id, src_id)
    clone = next(c for c in info["participants_config"] if c["id"] == out["id"])
    assert clone["role"] == "facilitator"


def test_update_meeting_rejects_empty_human_name(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("human-empty")
    monkeypatch.setattr(api, "STORE", store)

    with pytest.raises(HTTPException) as exc:
        api.update_meeting(meeting_id, api.MeetingUpdate(human_name="   "))
    assert exc.value.status_code == 400
    assert "human_name" in str(exc.value.detail)


def test_update_meeting_rejects_human_name_conflicting_with_participant(
    monkeypatch, tmp_path: Path
):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("human-conflict")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["participants_config"] = [{"id": "abc123", "name": "Alice", "engine_name": "Alice"}]
    monkeypatch.setattr(api, "STORE", store)

    with pytest.raises(HTTPException) as exc:
        api.update_meeting(meeting_id, api.MeetingUpdate(human_name="Alice"))
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_run_meeting_enables_human_with_custom_name(tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("human-run")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["include_human"] = True
    info["human_name"] = "Daisuke"

    meeting = info["meeting"]

    async def fake_run_free_conversation(*args, **kwargs):
        yield MeetingFinished(turns=0)

    meeting.run_free_conversation = fake_run_free_conversation
    store._ensure_runtime(meeting_id, "goal", 10, None)
    await store._run_meeting(meeting_id, "goal", 10, None)

    assert meeting._human_enabled is True
    assert meeting._human_name == "Daisuke"


def test_duplicate_meeting_keeps_participant_context_settings(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("source")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["participants_config"] = [
        {
            "model_name": "openai/gpt-4.1-2025-04-14",
            "temperature": 0.7,
            "seed": 42,
            "max_tokens": 1234,
            "max_context_length": 8192,
            "context_mode": "fixed_turns",
            "auto_compact_threshold": 0.8,
            "auto_compact_target": 0.5,
            "compact_recent_ratio": 0.6,
            "fixed_turns_count": 7,
            "name": "Alice",
            "background": "b",
            "personality": "p",
            "preferences": "pr",
            "personal_goals": "g",
            "role": "attendee",
            "speaking_style": "friendly",
            "explanation_style": "auto",
            "web_search": True,
            "max_steps": 5,
        }
    ]

    calls = []

    class DummyLLM:
        def __init__(self, **kwargs):
            self.max_context_length = kwargs.get("max_context_length")

    def fake_load_llm(**kwargs):
        calls.append(kwargs)
        return DummyLLM(**kwargs)

    monkeypatch.setattr(api, "STORE", store)
    monkeypatch.setattr(api, "load_llm", fake_load_llm)

    out = api.duplicate_meeting(meeting_id, api.MeetingCreate(title="copy"))
    target = store.get_meeting_info(out.id)
    assert target is not None
    p = target["meeting"].participants[0]

    assert calls[0]["max_tokens"] == 1234
    assert calls[0]["max_context_length"] == 8192
    assert p.context_mode == "fixed_turns"
    assert p.fixed_turns_count == 7


@pytest.mark.asyncio
async def test_effective_vote_turn_rule_when_linked(tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("runtime-linked")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["initialization_turn_rule"] = "inviting"
    info["vote_settings_linked"] = True
    info["vote_turn_rule"] = "random"

    captured = {}
    meeting = info["meeting"]

    async def fake_run_free_conversation(*args, **kwargs):
        captured.update(kwargs)
        yield MeetingFinished(turns=0)

    meeting.run_free_conversation = fake_run_free_conversation
    store._ensure_runtime(meeting_id, "goal", 10, None)
    await store._run_meeting(meeting_id, "goal", 10, None)

    assert captured.get("turn_rule") == "inviting"
    assert captured.get("vote_turn_rule") == "inviting"


@pytest.mark.asyncio
async def test_effective_vote_turn_rule_when_unlinked(tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("runtime-unlinked")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["initialization_turn_rule"] = "inviting"
    info["vote_settings_linked"] = False
    info["vote_turn_rule"] = "random"

    captured = {}
    meeting = info["meeting"]

    async def fake_run_free_conversation(*args, **kwargs):
        captured.update(kwargs)
        yield MeetingFinished(turns=0)

    meeting.run_free_conversation = fake_run_free_conversation
    store._ensure_runtime(meeting_id, "goal", 10, None)
    await store._run_meeting(meeting_id, "goal", 10, None)

    assert captured.get("turn_rule") == "inviting"
    assert captured.get("vote_turn_rule") == "random"

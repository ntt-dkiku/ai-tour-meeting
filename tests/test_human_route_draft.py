"""Tests for the /meetings/{id}/human_route_draft endpoint's model selection.

The endpoint never drafts "as" a participant: it calls
route_draft.draft_route_for_human (neutral assistant prompt) with an LLM
config. Covers:
- No model_name: drafts on participants[0]'s llm (default behavior).
- model_name matching an existing participant's config: reuses that
  participant's llm instead of building a new one.
- Novel model_name: builds an llm via load_llm with that model.
- Unavailable model_name: surfaces a 400.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from tour_meeting.backend import api
from tour_meeting.participant import Destination, RouteDraft

pytestmark = pytest.mark.asyncio(loop_scope="function")


def _create_store(tmp_path: Path) -> api.MeetingStore:
    return api.MeetingStore(storage_path=tmp_path / "meetings_test.json")


def _participant_in(name: str, model_name: str = "test/mock", **overrides) -> api.ParticipantIn:
    base = dict(
        model_name=model_name,
        temperature=0.0,
        seed=42,
        name=name,
        background="b",
        personality="p",
        preferences="pr",
        personal_goals="g",
        role="attendee",
        speaking_style="friendly",
        explanation_style="auto",
    )
    base.update(overrides)
    return api.ParticipantIn(**base)


def _fake_draft() -> RouteDraft:
    return RouteDraft(message="ok", route=[Destination(name="Stop 1")])


def _patch_drafter(monkeypatch) -> AsyncMock:
    mock = AsyncMock(return_value=_fake_draft())
    monkeypatch.setattr(api, "draft_route_for_human", mock)
    return mock


async def test_human_route_draft_defaults_to_first_participant_llm(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("draft-default")
    monkeypatch.setattr(api, "STORE", store)

    api.add_participant(meeting_id, _participant_in("Alice", model_name="openai/gpt-5-mini-2025-08-07"))
    api.add_participant(meeting_id, _participant_in("Bob", model_name="anthropic/claude-3-5-sonnet-20241022"))

    meeting = store.get_meeting(meeting_id)
    assert meeting is not None
    drafter = _patch_drafter(monkeypatch)

    req = api.HumanRouteDraftRequest(description="Plan a day", route=[])
    result = await api.human_route_draft(meeting_id, req)

    assert result["message"] == "ok"
    drafter.assert_awaited_once()
    assert drafter.await_args.kwargs["llm"] is meeting.participants[0].llm


async def test_human_route_draft_reuses_matching_participant_llm(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("draft-match")
    monkeypatch.setattr(api, "STORE", store)

    api.add_participant(meeting_id, _participant_in("Alice", model_name="openai/gpt-5-mini-2025-08-07"))
    api.add_participant(meeting_id, _participant_in("Bob", model_name="anthropic/claude-3-5-sonnet-20241022"))

    meeting = store.get_meeting(meeting_id)
    assert meeting is not None
    drafter = _patch_drafter(monkeypatch)

    req = api.HumanRouteDraftRequest(
        description="Plan a day", route=[], model_name="anthropic/claude-3-5-sonnet-20241022"
    )
    result = await api.human_route_draft(meeting_id, req)

    assert result["message"] == "ok"
    drafter.assert_awaited_once()
    assert drafter.await_args.kwargs["llm"] is meeting.participants[1].llm


async def test_human_route_draft_builds_llm_for_novel_model(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("draft-novel")
    monkeypatch.setattr(api, "STORE", store)

    api.add_participant(meeting_id, _participant_in("Alice", model_name="openai/gpt-5-mini-2025-08-07"))

    drafter = _patch_drafter(monkeypatch)
    override_llm = object()
    load_llm_calls = []

    def fake_load_llm(**kwargs):
        load_llm_calls.append(kwargs)
        return override_llm

    monkeypatch.setattr(api, "load_llm", fake_load_llm)

    req = api.HumanRouteDraftRequest(
        description="Plan a day", route=[], model_name="google/gemini-1.5-pro-latest"
    )
    result = await api.human_route_draft(meeting_id, req)

    assert result["message"] == "ok"
    assert len(load_llm_calls) == 1
    assert load_llm_calls[0]["model_name"] == "google/gemini-1.5-pro-latest"
    drafter.assert_awaited_once()
    assert drafter.await_args.kwargs["llm"] is override_llm


async def test_human_route_draft_raises_400_for_unavailable_model(monkeypatch, tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("draft-bad-model")
    monkeypatch.setattr(api, "STORE", store)

    api.add_participant(meeting_id, _participant_in("Alice", model_name="openai/gpt-5-mini-2025-08-07"))

    def broken_load_llm(**kwargs):
        raise ValueError("unknown model")

    monkeypatch.setattr(api, "load_llm", broken_load_llm)

    req = api.HumanRouteDraftRequest(
        description="Plan a day", route=[], model_name="bogus/does-not-exist"
    )
    with pytest.raises(HTTPException) as exc:
        await api.human_route_draft(meeting_id, req)
    assert exc.value.status_code == 400
    assert "bogus/does-not-exist" in str(exc.value.detail)

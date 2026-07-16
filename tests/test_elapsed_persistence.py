"""Tests for elapsed-time persistence across store reloads."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from tour_meeting.backend import api


def _create_store(tmp_path: Path) -> api.MeetingStore:
    return api.MeetingStore(storage_path=tmp_path / "meetings_test.json")


def test_store_persists_elapsed_seconds(tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("elapsed")
    info = store.get_meeting_info(meeting_id)
    assert info is not None

    info["elapsed_seconds"] = 123
    store.save()

    reloaded = api.MeetingStore(storage_path=tmp_path / "meetings_test.json")
    loaded = reloaded.get_meeting_info(meeting_id)
    assert loaded is not None
    assert loaded.get("elapsed_seconds") == 123


def test_list_meetings_includes_elapsed_seconds(tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("list-elapsed")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["elapsed_seconds"] = 45
    store.save()

    meetings = store.list_meetings()
    item = next(m for m in meetings if m["id"] == meeting_id)
    assert item["elapsed_seconds"] == 45


def test_list_meetings_reports_live_elapsed_for_running_meeting(tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("live-elapsed")

    runtime = store._ensure_runtime(meeting_id, "goal", 10, None)
    runtime.accumulated = 30.0
    runtime.started_at = time.monotonic() - 10

    meetings = store.list_meetings()
    item = next(m for m in meetings if m["id"] == meeting_id)
    assert 39 <= item["elapsed_seconds"] <= 42


def test_save_refreshes_elapsed_from_active_runtime(tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("save-refresh")

    runtime = store._ensure_runtime(meeting_id, "goal", 10, None)
    runtime.accumulated = 77.0
    runtime.started_at = None
    store.save()

    reloaded = api.MeetingStore(storage_path=tmp_path / "meetings_test.json")
    loaded = reloaded.get_meeting_info(meeting_id)
    assert loaded is not None
    assert loaded.get("elapsed_seconds") == 77


def test_ensure_runtime_seeds_accumulated_from_persisted_elapsed(tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("seed")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["elapsed_seconds"] = 200

    runtime = store._ensure_runtime(meeting_id, "goal", 10, None)
    assert runtime.accumulated == 200.0


def test_stop_meeting_runtime_records_elapsed(tmp_path: Path):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("stop-elapsed")

    runtime = store._ensure_runtime(meeting_id, "goal", 10, None)
    runtime.accumulated = 55.0
    runtime.started_at = None

    assert store.stop_meeting_runtime(meeting_id) is True
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    assert info.get("elapsed_seconds") == 55


def test_load_backfills_elapsed_from_analytics_duration():
    payload = {"analytics_data": {"metadata": {"duration": 498.57}}}
    assert api.MeetingStore._resolve_persisted_elapsed(payload) == 498


def test_load_prefers_stored_elapsed_over_analytics():
    payload = {
        "elapsed_seconds": 12,
        "analytics_data": {"metadata": {"duration": 498.57}},
    }
    assert api.MeetingStore._resolve_persisted_elapsed(payload) == 12


def test_load_defaults_elapsed_to_zero():
    assert api.MeetingStore._resolve_persisted_elapsed({}) == 0


@pytest.mark.asyncio
async def test_reset_meeting_clears_elapsed(tmp_path: Path, monkeypatch):
    store = _create_store(tmp_path)
    meeting_id = store.create_meeting("reset-elapsed")
    info = store.get_meeting_info(meeting_id)
    assert info is not None
    info["elapsed_seconds"] = 88
    monkeypatch.setattr(api, "STORE", store)

    await api.reset_meeting(meeting_id)
    assert info.get("elapsed_seconds") == 0

    reloaded = api.MeetingStore(storage_path=tmp_path / "meetings_test.json")
    loaded = reloaded.get_meeting_info(meeting_id)
    assert loaded is not None
    assert loaded.get("elapsed_seconds") == 0

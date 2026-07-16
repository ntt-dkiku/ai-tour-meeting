from tour_meeting.analytics import MeetingAnalytics


def test_termination_reason_default_is_none():
    analytics = MeetingAnalytics()
    assert analytics.termination_reason is None


def test_meeting_finished_records_reason():
    analytics = MeetingAnalytics()
    analytics.meeting_started()
    analytics.meeting_finished(reason="consensus")

    assert analytics.termination_reason == "consensus"
    assert analytics.end_time is not None


def test_meeting_finished_default_reason_is_unknown():
    analytics = MeetingAnalytics()
    analytics.meeting_started()
    analytics.meeting_finished()

    assert analytics.termination_reason == "unknown"


def test_termination_reason_in_get_summary():
    analytics = MeetingAnalytics()
    analytics.meeting_started()
    analytics.meeting_finished(reason="max_turns")

    summary = analytics.get_summary()
    assert summary["termination_reason"] == "max_turns"


def test_termination_reason_none_when_not_finished():
    analytics = MeetingAnalytics()
    analytics.meeting_started()

    summary = analytics.get_summary()
    assert summary["termination_reason"] is None


def test_termination_reason_in_export_to_dict():
    analytics = MeetingAnalytics()
    analytics.meeting_started()
    analytics.meeting_finished(reason="timeout")

    exported = analytics.export_to_dict()
    assert exported["metadata"]["termination_reason"] == "timeout"


def test_termination_reason_roundtrip_via_restore():
    analytics = MeetingAnalytics()
    analytics.meeting_started()
    analytics.meeting_finished(reason="stopped")
    exported = analytics.export_to_dict()

    restored = MeetingAnalytics()
    restored.restore_from_dict(exported)

    assert restored.termination_reason == "stopped"


def test_termination_reason_restore_missing_key():
    """Old data without termination_reason should restore as None."""
    restored = MeetingAnalytics()
    restored.restore_from_dict({
        "metadata": {"start_time": 1.0, "end_time": 2.0},
    })

    assert restored.termination_reason is None

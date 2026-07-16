from tour_meeting.analytics import ActivityMetrics, MeetingAnalytics


# ---------------------------------------------------------------------------
# Action counts
# ---------------------------------------------------------------------------

def test_record_action_increments():
    m = ActivityMetrics()
    m.record_action("Alice", "proposal")
    m.record_action("Alice", "discuss")
    m.record_action("Alice", "proposal")
    m.record_action("Bob", "satisfied")

    assert m.action_counts == {
        "Alice": {"proposal": 2, "discuss": 1},
        "Bob": {"satisfied": 1},
    }


def test_action_counts_in_export_roundtrip():
    analytics = MeetingAnalytics()
    analytics.record_action("Alice", "proposal")
    analytics.record_action("Alice", "discuss")

    exported = analytics.export_to_dict()
    assert exported["discussion_dynamics"]["activity"]["action_counts"] == {
        "Alice": {"proposal": 1, "discuss": 1},
    }

    restored = MeetingAnalytics()
    restored.restore_from_dict(exported)
    assert restored.discussion_dynamics.activity.action_counts == {
        "Alice": {"proposal": 1, "discuss": 1},
    }


def test_action_counts_in_summary():
    analytics = MeetingAnalytics()
    analytics.record_action("Bob", "pass")

    summary = analytics.get_summary()
    assert summary["discussion_dynamics"]["activity"]["action_counts"] == {
        "Bob": {"pass": 1},
    }


# ---------------------------------------------------------------------------
# Satisfied progression
# ---------------------------------------------------------------------------

def test_record_satisfied_state():
    analytics = MeetingAnalytics()
    analytics.record_satisfied_state(turn=3, speaker="Alice", satisfied_count=1, total_count=3)
    analytics.record_satisfied_state(turn=5, speaker="Bob", satisfied_count=2, total_count=3)

    assert len(analytics.satisfied_progression) == 2
    assert analytics.satisfied_progression[0] == {
        "turn": 3, "speaker": "Alice", "satisfied_count": 1, "total_count": 3,
    }
    assert analytics.satisfied_progression[1]["satisfied_count"] == 2


def test_satisfied_progression_in_export_roundtrip():
    analytics = MeetingAnalytics()
    analytics.record_satisfied_state(turn=1, speaker="A", satisfied_count=1, total_count=2)

    exported = analytics.export_to_dict()
    assert exported["satisfied_progression"] == [
        {"turn": 1, "speaker": "A", "satisfied_count": 1, "total_count": 2},
    ]

    restored = MeetingAnalytics()
    restored.restore_from_dict(exported)
    assert restored.satisfied_progression == [
        {"turn": 1, "speaker": "A", "satisfied_count": 1, "total_count": 2},
    ]


def test_satisfied_progression_in_summary():
    analytics = MeetingAnalytics()
    analytics.record_satisfied_state(turn=2, speaker="X", satisfied_count=1, total_count=3)

    summary = analytics.get_summary()
    assert summary["satisfied_progression"] == [
        {"turn": 2, "speaker": "X", "satisfied_count": 1, "total_count": 3},
    ]


# ---------------------------------------------------------------------------
# Compaction events
# ---------------------------------------------------------------------------

def test_record_compaction():
    m = ActivityMetrics()
    m.record_compaction("Alice", turn=5, tokens_before=8000, tokens_after=4000)

    assert len(m.compaction_events) == 1
    assert m.compaction_events[0] == {
        "turn": 5, "agent": "Alice", "tokens_before": 8000, "tokens_after": 4000,
    }


def test_compaction_via_meeting_analytics():
    analytics = MeetingAnalytics()
    analytics.record_compaction("Bob", turn=3, tokens_before=6000, tokens_after=3000)

    assert len(analytics.discussion_dynamics.activity.compaction_events) == 1


def test_compaction_in_export_roundtrip():
    analytics = MeetingAnalytics()
    analytics.record_compaction("Alice", turn=2, tokens_before=5000, tokens_after=2500)

    exported = analytics.export_to_dict()
    assert exported["discussion_dynamics"]["activity"]["compaction_events"] == [
        {"turn": 2, "agent": "Alice", "tokens_before": 5000, "tokens_after": 2500},
    ]

    restored = MeetingAnalytics()
    restored.restore_from_dict(exported)
    assert restored.discussion_dynamics.activity.compaction_events == [
        {"turn": 2, "agent": "Alice", "tokens_before": 5000, "tokens_after": 2500},
    ]


def test_compaction_in_summary():
    analytics = MeetingAnalytics()
    analytics.record_compaction("Alice", turn=4, tokens_before=7000, tokens_after=3500)

    summary = analytics.get_summary()
    assert summary["discussion_dynamics"]["activity"]["compaction_events"] == [
        {"turn": 4, "agent": "Alice", "tokens_before": 7000, "tokens_after": 3500},
    ]


# ---------------------------------------------------------------------------
# Backward compatibility (old data without new keys)
# ---------------------------------------------------------------------------

def test_restore_missing_new_keys():
    restored = MeetingAnalytics()
    restored.restore_from_dict({
        "discussion_dynamics": {"activity": {}, "proposals": {}, "consensus": {}},
        "route_characteristics": {},
        "metadata": {},
    })

    assert restored.discussion_dynamics.activity.action_counts == {}
    assert restored.discussion_dynamics.activity.compaction_events == []
    assert restored.satisfied_progression == []

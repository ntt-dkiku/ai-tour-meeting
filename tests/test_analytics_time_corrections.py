from tour_meeting.analytics import RouteCharacteristics, MeetingAnalytics


def test_record_time_corrections_stores_entries():
    rc = RouteCharacteristics()
    rc.record_time_corrections(
        turn=3,
        speaker="Alice",
        adjustments=[
            "- Sagrada Familia: 10:00 -> 10:30",
            "- La Boqueria: 11:00 -> 11:45",
        ],
    )

    assert len(rc.time_corrections) == 2
    assert rc.time_corrections[0] == {
        "turn": 3,
        "speaker": "Alice",
        "adjustment": "- Sagrada Familia: 10:00 -> 10:30",
    }
    assert rc.time_corrections[1]["speaker"] == "Alice"


def test_record_time_corrections_empty_adjustments_no_op():
    rc = RouteCharacteristics()
    rc.record_time_corrections(turn=1, speaker="Bob", adjustments=[])
    assert rc.time_corrections == []


def test_record_time_corrections_multiple_turns():
    rc = RouteCharacteristics()
    rc.record_time_corrections(turn=1, speaker="Alice", adjustments=["- A: 09:00 -> 09:30"])
    rc.record_time_corrections(turn=5, speaker="Bob", adjustments=["- B: 12:00 -> 12:15"])

    assert len(rc.time_corrections) == 2
    assert rc.time_corrections[0]["turn"] == 1
    assert rc.time_corrections[1]["turn"] == 5
    assert rc.time_corrections[1]["speaker"] == "Bob"


def test_meeting_analytics_delegates_time_corrections():
    analytics = MeetingAnalytics()
    analytics.record_time_corrections(
        turn=2,
        speaker="Charlie",
        adjustments=["- Museum: 14:00 -> 14:20"],
    )

    assert len(analytics.route_characteristics.time_corrections) == 1
    assert analytics.route_characteristics.time_corrections[0]["speaker"] == "Charlie"


def test_time_corrections_in_get_summary():
    analytics = MeetingAnalytics()
    analytics.record_time_corrections(
        turn=4, speaker="Alice", adjustments=["- Park: 15:00 -> 15:30"]
    )

    summary = analytics.get_summary()
    assert summary["route_characteristics"]["time_corrections"] == [
        {"turn": 4, "speaker": "Alice", "adjustment": "- Park: 15:00 -> 15:30"}
    ]


def test_time_corrections_in_export_to_dict():
    analytics = MeetingAnalytics()
    analytics.record_time_corrections(
        turn=2, speaker="Bob", adjustments=["- Beach: 10:00 -> 10:20"]
    )

    exported = analytics.export_to_dict()
    assert exported["route_characteristics"]["time_corrections"] == [
        {"turn": 2, "speaker": "Bob", "adjustment": "- Beach: 10:00 -> 10:20"}
    ]


def test_time_corrections_roundtrip_via_restore():
    analytics = MeetingAnalytics()
    analytics.record_time_corrections(
        turn=3, speaker="Alice", adjustments=["- Temple: 09:00 -> 09:15"]
    )
    exported = analytics.export_to_dict()

    restored = MeetingAnalytics()
    restored.restore_from_dict(exported)

    assert restored.route_characteristics.time_corrections == [
        {"turn": 3, "speaker": "Alice", "adjustment": "- Temple: 09:00 -> 09:15"}
    ]

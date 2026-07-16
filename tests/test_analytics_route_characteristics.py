from tour_meeting.analytics import RouteCharacteristics


def _route(cost: str = "10", stay: str = "30min", summary_cost: str = "10") -> dict:
    return {
        "destinations": [
            {
                "name": "A",
                "stay_duration": stay,
                "travel_time_from_previous": "10min",
                "cost": cost,
                "transport_cost": "0",
            },
            {
                "name": "B",
                "stay_duration": "20min",
                "travel_time_from_previous": "15min",
                "cost": "0",
                "transport_cost": "5",
            },
        ],
        "summary": {
            "total_cost": summary_cost,
        },
    }


def test_record_route_skips_only_fully_identical_snapshot():
    rc = RouteCharacteristics()
    route = _route()

    rc.record_route(turn=1, route_data=route, phase="accepted")
    rc.record_route(turn=2, route_data=route, phase="accepted")

    assert len(rc.route_snapshots) == 1


def test_record_route_keeps_snapshot_when_only_cost_changes():
    rc = RouteCharacteristics()

    rc.record_route(turn=1, route_data=_route(cost="10"), phase="accepted")
    rc.record_route(turn=2, route_data=_route(cost="12"), phase="accepted")

    assert len(rc.route_snapshots) == 2


def test_record_route_keeps_snapshot_when_only_time_changes():
    rc = RouteCharacteristics()

    rc.record_route(turn=1, route_data=_route(stay="30min"), phase="accepted")
    rc.record_route(turn=2, route_data=_route(stay="45min"), phase="accepted")

    assert len(rc.route_snapshots) == 2


def test_record_route_keeps_snapshot_when_only_summary_changes():
    rc = RouteCharacteristics()

    rc.record_route(turn=1, route_data=_route(summary_cost="10"), phase="accepted")
    rc.record_route(turn=2, route_data=_route(summary_cost="11"), phase="accepted")

    assert len(rc.route_snapshots) == 2


def test_transitions_include_only_accepted_snapshots():
    rc = RouteCharacteristics()

    rc.record_route(turn=1, route_data=_route(cost="8"), phase="proposal")
    rc.record_route(turn=2, route_data=_route(cost="10"), phase="accepted")
    rc.record_route(turn=3, route_data=_route(cost="12"), phase="proposal")
    rc.record_route(turn=4, route_data=_route(cost="14"), phase="accepted")

    travel = rc.travel_time_transition()
    costs = rc.cost_transition()
    counts = rc.destination_count_transition()

    assert [t for t, _ in travel] == [2, 4]
    # cost strings in _route carry no currency symbol -> '' series
    assert [t for t, _ in costs[""]] == [2, 4]
    assert [t for t, _ in counts] == [2, 4]


def test_cost_transition_separates_currencies():
    rc = RouteCharacteristics()

    def route(cost1: str, cost2: str) -> dict:
        return {
            "destinations": [
                {"name": "A", "cost": cost1, "transport_cost": "¥200"},
                {"name": "B", "cost": cost2, "transport_cost": ""},
            ],
        }

    rc.record_route(turn=1, route_data=route("$20", "¥1,500"), phase="accepted")
    rc.record_route(turn=3, route_data=route("$25", "¥1,000"), phase="accepted")

    costs = rc.cost_transition()

    assert costs["$"] == [(1, 20.0), (3, 25.0)]
    assert costs["¥"] == [(1, 1700.0), (3, 1200.0)]


def test_cost_transition_falls_back_for_legacy_snapshots():
    rc = RouteCharacteristics()
    # Simulate a snapshot persisted before cost_by_currency existed.
    rc.route_snapshots.append({
        "turn": 2,
        "phase": "accepted",
        "destinations": [],
        "travel_time": 0.0,
        "cost": 940.0,
        "num_destinations": 0,
        "route_signature": "legacy",
    })

    costs = rc.cost_transition()

    assert costs[""] == [(2, 940.0)]


def test_final_stats_are_based_on_latest_accepted_snapshot():
    rc = RouteCharacteristics()

    route_accept = _route()
    route_proposal_after = _route()
    route_proposal_after["destinations"].append(
        {
            "name": "C",
            "stay_duration": "15min",
            "travel_time_from_previous": "5min",
            "cost": "3",
            "transport_cost": "0",
        }
    )

    rc.record_route(turn=1, route_data=route_accept, phase="accepted")
    rc.record_route(turn=2, route_data=route_proposal_after, phase="proposal")

    coverage = rc.destination_coverage({"A", "B", "C"})
    final_count = rc.final_destinations_count()

    assert coverage == 2 / 3
    assert final_count == 2

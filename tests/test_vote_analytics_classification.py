from tour_meeting.analytics import MeetingAnalytics
from tour_meeting.tour_meeting import AITourMeeting


def test_majority_and_single_decider_use_approval_votes():
    assert AITourMeeting._analytics_vote_score("majority", {"accept": True}) is None
    assert AITourMeeting._analytics_vote_score("unanimous", {"accept": True}) is None
    assert AITourMeeting._analytics_vote_score("single_decider", {"accept": False}) is None


def test_score_rules_use_explicit_score_when_present():
    assert AITourMeeting._analytics_vote_score("most_pleasure", {"score": "6.5"}) == 6.5


def test_score_rules_derive_from_scores_list_for_route_one():
    vote_obj = {
        "scores": [
            {"route_id": 1, "score": 8},
            {"route_id": 1, "score": "6"},
            {"route_id": 2, "score": 9},
        ]
    }
    assert AITourMeeting._analytics_vote_score("least_misery", vote_obj) == 7.0


def test_score_rules_fallback_to_accept_binary_when_score_missing():
    assert AITourMeeting._analytics_vote_score("most_pleasure", {"accept": True}) == 1.0
    assert AITourMeeting._analytics_vote_score("least_misery", {"accept": False}) == 0.0


def test_approval_counts_only_accept_votes():
    analytics = MeetingAnalytics()
    analytics.vote_recorded("A", "P1", score=None, approved=True, turn=1)
    analytics.vote_recorded("A", "P1", score=None, approved=False, turn=2)
    analytics.vote_recorded("B", "P2", score=None, approved=False, turn=3)

    summary = analytics.get_summary()
    approval = summary["discussion_dynamics"]["consensus"]["approval"]
    assert approval["total_votes"] == 3
    assert approval["total_approval_votes"] == 1
    assert approval["total_reject_votes"] == 2
    assert approval["votes_per_agent"] == {"A": 1}
    assert approval["approval_votes_per_agent"] == {"A": 1}
    assert approval["reject_votes_per_agent"] == {"A": 1, "B": 1}
    assert approval["received_approval_votes_per_agent"] == {"P1": 1}
    assert approval["received_reject_votes_per_agent"] == {"P1": 1, "P2": 1}


def test_majority_decision_can_include_proposer_implicit_accept():
    votes = [
        {"participant": "B", "accept": False},
        {"participant": "C", "accept": True},
    ]
    assert AITourMeeting._is_majority_accepted(votes, include_proposer_implicit_accept=False) is False
    assert AITourMeeting._is_majority_accepted(votes, include_proposer_implicit_accept=True) is True


def test_unanimous_decision_requires_all_voters_accept():
    assert AITourMeeting._is_unanimous_accepted(
        [{"participant": "B", "accept": True}, {"participant": "C", "accept": True}],
        include_proposer_implicit_accept=True,
    ) is True
    assert AITourMeeting._is_unanimous_accepted(
        [{"participant": "B", "accept": True}, {"participant": "C", "accept": False}],
        include_proposer_implicit_accept=True,
    ) is False


def test_route_representative_score_sum_uses_all_voter_scores():
    votes = [
        {"participant": "A", "score": 7},
        {"participant": "B", "scores": [{"route_id": 1, "score": "6"}]},
        {"participant": "C", "scores": [{"route_id": 2, "score": 9}]},
    ]
    assert AITourMeeting._route_representative_score(votes, mode="sum") == 13.0


def test_route_representative_score_min_uses_lowest_voter_score():
    votes = [
        {"participant": "A", "score": 8},
        {"participant": "B", "scores": [{"route_id": 1, "score": 3}]},
        {"participant": "C", "score": 9},
    ]
    assert AITourMeeting._route_representative_score(votes, mode="min") == 3.0


def test_route_representative_score_returns_none_without_score_payload():
    votes = [
        {"participant": "A", "accept": True},
        {"participant": "B", "scores": [{"route_id": 2, "score": 5}]},
    ]
    assert AITourMeeting._route_representative_score(votes, mode="sum") is None

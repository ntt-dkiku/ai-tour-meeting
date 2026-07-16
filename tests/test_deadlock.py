"""Tests for the deadlock detector and its intervention wiring.

Covers:
- Each signal (proposal stagnation / message repetition / satisfied
  stagnation) fires on synthetic deadlock data and stays quiet on progress
- The default combination requires ALL enabled signals to agree
- Signal combinations are configurable; unknown signals are rejected
- Cooldown and max-interventions limits
- MeetingAnalytics records interventions and round-trips them through
  export/restore
"""

from __future__ import annotations

import pytest

from tour_meeting.analytics import MeetingAnalytics
from tour_meeting.deadlock import DEFAULT_SIGNALS, DeadlockDetector


def _dest(*names: str):
    return [{"name": n} for n in names]


def _make_detector(**overrides) -> DeadlockDetector:
    kwargs = dict(
        window=3,
        route_similarity_threshold=0.7,
        text_similarity_threshold=0.8,
        num_participants=2,  # stagnation after window*2 = 6 turns
        max_interventions=2,
        cooldown_turns=4,
    )
    kwargs.update(overrides)
    return DeadlockDetector(**kwargs)


def _feed_deadlock(det: DeadlockDetector, start_turn: int = 10) -> int:
    """Feed a textbook deadlock: 3 near-identical rejected proposals and a
    participant repeating the same argument. Returns the last turn number."""
    turn = start_turn
    for i in range(3):
        det.observe_proposal(
            turn=turn,
            proposer="Elena",
            # Same route re-submitted with a single swapped stop:
            # Jaccard = 5/7 ≈ 0.71 per pair, above the 0.7 threshold.
            destinations=_dest(
                "Palace", "Museum", "Market", "Garden", "Harbor", f"Cafe {i}"
            ),
            accepted=False,
        )
        det.observe_message(
            "Marcus",
            "I need to reject this proposal. My sit-down lunch near the palace "
            "is being replaced with street food, which contradicts my preference "
            f"for a proper meal. (round {i})",
        )
        turn += 3
    return turn


class TestSignals:
    def test_all_signals_fire_on_deadlock(self):
        det = _make_detector()
        last_turn = _feed_deadlock(det)
        evidence = det.check(last_turn)
        assert evidence is not None
        assert set(evidence.signals) == set(DEFAULT_SIGNALS)
        assert "rejected" in evidence.describe()

    def test_accepted_proposal_blocks_proposal_stagnation(self):
        det = _make_detector()
        last_turn = _feed_deadlock(det)
        det.observe_proposal(
            turn=last_turn, proposer="Mina",
            destinations=_dest("Palace", "Museum", "Market"), accepted=True,
        )
        assert det.check(last_turn + 1) is None

    def test_dissimilar_proposals_do_not_fire(self):
        det = _make_detector(signals=("proposal_stagnation",))
        routes = [
            _dest("Palace", "Museum"),
            _dest("Beach", "Harbor"),
            _dest("Temple", "Garden"),
        ]
        turn = 10
        for r in routes:
            det.observe_proposal(turn=turn, proposer="Elena", destinations=r, accepted=False)
            turn += 3
        assert det.check(turn) is None

    def test_varied_messages_do_not_fire(self):
        det = _make_detector(signals=("message_repetition",))
        det.observe_message("Marcus", "I think we should start with the palace in the morning.")
        det.observe_message("Marcus", "The harbor route sounds great, let's add a lunch stop.")
        det.observe_message("Marcus", "Actually the museum matters most to me, can we extend it?")
        assert det.check(20) is None

    def test_vote_rationale_repetition_fires_in_own_channel(self):
        det = _make_detector(signals=("message_repetition",))
        # Varied speaking turns...
        det.observe_message("Marcus", "Let's look at the palace first.", channel="turn")
        det.observe_message("Marcus", "How about adding the harbor?", channel="turn")
        det.observe_message("Marcus", "The museum is my top priority.", channel="turn")
        # ...but the same reject rationale on every vote
        rationale = (
            "I need to reject this: my sit-down lunch near the palace is being "
            "replaced with street food, which contradicts my preference."
        )
        for _ in range(3):
            det.observe_message("Marcus", rationale, channel="vote")
        evidence = det.check(20)
        assert evidence is not None
        assert "vote rationale" in evidence.describe()

    def test_channels_do_not_mix(self):
        det = _make_detector(signals=("message_repetition",))
        # The same text alternating between channels never fills either
        # channel's window on its own.
        det.observe_message("Marcus", "Same text.", channel="turn")
        det.observe_message("Marcus", "Same text.", channel="vote")
        det.observe_message("Marcus", "Same text.", channel="turn")
        det.observe_message("Marcus", "Same text.", channel="vote")
        assert det.check(20) is None

    def test_satisfied_progress_blocks_stagnation(self):
        # stagnation budget = window * num_participants = 3 * 2 = 6 turns
        det = _make_detector(signals=("satisfied_stagnation",))
        det.observe_satisfied(turn=8, satisfied_count=2)  # new maximum = progress
        assert det.check(10) is None
        # ... but stalling long after the last progress fires
        assert det.check(14) is not None


class TestSignalCombination:
    def test_single_signal_combination(self):
        det = _make_detector(signals=("proposal_stagnation",))
        last_turn = _feed_deadlock(det)
        evidence = det.check(last_turn)
        assert evidence is not None
        assert evidence.signals == ["proposal_stagnation"]

    def test_all_enabled_signals_must_agree(self):
        # Message repetition alone must not fire the default (a+b+c) combo.
        det = _make_detector()
        for _ in range(3):
            det.observe_message("Marcus", "I reject this: my lunch plan is being replaced again.")
        det.observe_proposal(turn=5, proposer="Mina", destinations=_dest("A", "B"), accepted=True)
        assert det.check(6) is None

    def test_unknown_signal_rejected(self):
        with pytest.raises(ValueError):
            DeadlockDetector(signals=("proposal_stagnation", "vibes"))

    def test_empty_signals_rejected(self):
        with pytest.raises(ValueError):
            DeadlockDetector(signals=())


class TestInterventionLimits:
    def test_cooldown_suppresses_immediate_refire(self):
        det = _make_detector(cooldown_turns=4, max_interventions=5)
        last_turn = _feed_deadlock(det)
        assert det.check(last_turn) is not None
        # Still deadlocked, but within the cooldown window
        assert det.check(last_turn + 2) is None
        assert det.check(last_turn + 4) is not None

    def test_max_interventions_cap(self):
        det = _make_detector(cooldown_turns=0, max_interventions=1)
        last_turn = _feed_deadlock(det)
        assert det.check(last_turn) is not None
        assert det.check(last_turn + 10) is None

    def test_negative_max_interventions_is_unlimited(self):
        det = _make_detector(cooldown_turns=0, max_interventions=-1)
        last_turn = _feed_deadlock(det)
        for offset in range(5):
            assert det.check(last_turn + offset) is not None
        assert det.intervention_count == 5

    def test_intervention_message_mentions_options(self):
        det = _make_detector()
        last_turn = _feed_deadlock(det)
        evidence = det.check(last_turn)
        message = det.build_intervention_message(evidence)
        assert "STRUCTURALLY different" in message
        assert "minimum concession" in message
        assert "satisfied" in message


class TestAnalytics:
    def test_record_and_roundtrip(self):
        analytics = MeetingAnalytics()
        analytics.record_deadlock_intervention(12, ["proposal_stagnation"], "msg")
        exported = analytics.export_to_dict()
        assert exported["deadlock_interventions"] == [
            {"turn": 12, "signals": ["proposal_stagnation"], "message": "msg"}
        ]
        restored = MeetingAnalytics()
        restored.restore_from_dict(exported)
        assert restored.deadlock_interventions == analytics.deadlock_interventions
        assert analytics.get_summary()["deadlock_interventions"]

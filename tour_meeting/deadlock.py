"""Deadlock detection and intervention for free-conversation meetings.

A meeting is considered deadlocked when the discussion keeps cycling without
making progress: near-identical proposals get rejected over and over while
participants repeat the same arguments. Detection is signal-based, and which
signals participate is configurable via the ``deadlock_detection`` meeting
setting:

- ``proposal_stagnation`` (a): the last ``window`` proposals were all
  rejected and are near-duplicates of each other (Jaccard similarity over
  normalized destination names >= ``route_similarity_threshold``).
- ``message_repetition`` (b): some participant's last ``window`` messages
  are near-identical (difflib ratio >= ``text_similarity_threshold``).
  Speaking-turn conclusions and vote rationales are tracked as separate
  channels per participant, so repetition is judged within each channel
  (e.g. three near-identical reject rationales fire even when the same
  participant's turn messages vary).
- ``satisfied_stagnation`` (c): no proposal has been accepted and the
  satisfied count has not reached a new maximum for ``window`` rounds
  (``window * num_participants`` turns).

A deadlock fires only when ALL enabled signals agree. On detection the
meeting injects a neutral "System" mediation message into the shared history
so every participant sees it on their next turn.
"""
from __future__ import annotations

import difflib
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

DEFAULT_SIGNALS: Tuple[str, ...] = (
    "proposal_stagnation",
    "message_repetition",
    "satisfied_stagnation",
)


def _route_signature(destinations: Sequence[Dict[str, Any]]) -> frozenset:
    """Normalized destination-name set used to compare proposals."""
    return frozenset(
        str(d.get("name", "")).strip().lower()
        for d in (destinations or [])
        if str(d.get("name", "")).strip()
    )


def _jaccard(a: frozenset, b: frozenset) -> float:
    if not a and not b:
        return 1.0
    union = a | b
    if not union:
        return 1.0
    return len(a & b) / len(union)


def _text_similarity(a: str, b: str) -> float:
    # Cap length so pathological outputs stay cheap to compare.
    return difflib.SequenceMatcher(None, a[:2000].lower(), b[:2000].lower()).ratio()


@dataclass
class DeadlockEvidence:
    """Why the detector believes the meeting is deadlocked."""
    turn: int
    signals: List[str]
    details: Dict[str, str] = field(default_factory=dict)

    def describe(self) -> str:
        return " ".join(self.details[s] for s in self.signals if s in self.details)


class DeadlockDetector:
    """Sliding-window deadlock detector fed by meeting events.

    Args:
        signals: Which signals must ALL fire for a deadlock
            (subset of ``DEFAULT_SIGNALS``).
        window: Single knob for "how much recent history counts as a cycle":
            the last ``window`` proposals (signal a), the last ``window``
            messages per participant (signal b), and ``window`` rounds
            without progress (signal c, i.e. ``window * num_participants``
            turns).
        route_similarity_threshold: Mean pairwise Jaccard similarity of the
            last ``window`` rejected proposals at/above which they count as
            "the same proposal repeated" (default 0.8).
        text_similarity_threshold: Mean pairwise difflib ratio of one
            participant's last ``window`` messages at/above which they count
            as repetition.
        num_participants: Meeting size; converts ``window`` rounds into the
            turn budget used by the stagnation signal.
        max_interventions: Cap on interventions per meeting; -1 = unlimited.
        cooldown_turns: Minimum turns between two interventions.
    """

    def __init__(
        self,
        signals: Sequence[str] = DEFAULT_SIGNALS,
        window: int = 3,
        route_similarity_threshold: float = 0.8,
        text_similarity_threshold: float = 0.8,
        num_participants: int = 1,
        max_interventions: int = -1,
        cooldown_turns: int = 6,
    ):
        unknown = set(signals) - set(DEFAULT_SIGNALS)
        if unknown:
            raise ValueError(
                f"Unknown deadlock signals: {sorted(unknown)}; "
                f"must be a subset of {list(DEFAULT_SIGNALS)}"
            )
        if not signals:
            raise ValueError("At least one deadlock signal must be enabled.")
        self.signals: Tuple[str, ...] = tuple(signals)
        self.window = max(2, int(window))
        self.route_similarity_threshold = float(route_similarity_threshold)
        self.text_similarity_threshold = float(text_similarity_threshold)
        self.stagnation_turns = self.window * max(1, int(num_participants))
        self.max_interventions = int(max_interventions)
        self.cooldown_turns = max(0, int(cooldown_turns))

        # (turn, proposer, signature, accepted) for every voted proposal
        self._proposals: List[Tuple[int, str, frozenset, bool]] = []
        # Recent messages keyed by (participant, channel); "turn" holds
        # speaking-turn conclusions, "vote" holds vote rationales.
        self._messages: Dict[Tuple[str, str], List[str]] = {}
        self._max_satisfied = 0
        self._last_progress_turn = 0
        self._last_intervention_turn: Optional[int] = None
        self.intervention_count = 0

    # ── Observations ───────────────────────────────────────────────

    def observe_message(self, speaker: str, text: str, channel: str = "turn") -> None:
        text = (text or "").strip()
        if not text:
            return
        bucket = self._messages.setdefault((speaker, channel), [])
        bucket.append(text)
        del bucket[: -self.window]

    def observe_proposal(
        self,
        turn: int,
        proposer: str,
        destinations: Sequence[Dict[str, Any]],
        accepted: bool,
    ) -> None:
        self._proposals.append((turn, proposer, _route_signature(destinations), accepted))
        if accepted:
            self._last_progress_turn = turn

    def observe_satisfied(self, turn: int, satisfied_count: int) -> None:
        if satisfied_count > self._max_satisfied:
            self._max_satisfied = satisfied_count
            self._last_progress_turn = turn

    # ── Signal checks (each returns a human-readable detail or None) ──

    def _check_proposal_stagnation(self) -> Optional[str]:
        recent = self._proposals[-self.window:]
        if len(recent) < self.window:
            return None
        if any(accepted for (_, _, _, accepted) in recent):
            return None
        sims = [
            _jaccard(recent[i][2], recent[j][2])
            for i in range(len(recent))
            for j in range(i + 1, len(recent))
        ]
        mean_sim = sum(sims) / len(sims) if sims else 0.0
        if mean_sim >= self.route_similarity_threshold:
            return (
                f"The last {len(recent)} route proposals were all rejected and were "
                f"nearly identical to each other (avg. destination overlap "
                f"{mean_sim:.0%})."
            )
        return None

    def _check_message_repetition(self) -> Optional[str]:
        for (speaker, channel), texts in self._messages.items():
            if len(texts) < self.window:
                continue
            sims = [
                _text_similarity(texts[i], texts[j])
                for i in range(len(texts))
                for j in range(i + 1, len(texts))
            ]
            mean_sim = sum(sims) / len(sims) if sims else 0.0
            if mean_sim >= self.text_similarity_threshold:
                what = "vote rationale" if channel == "vote" else "statement"
                return (
                    f"{speaker} has been repeating essentially the same {what} "
                    f"{len(texts)} times in a row."
                )
        return None

    def _check_satisfied_stagnation(self, turn: int) -> Optional[str]:
        stalled_for = turn - self._last_progress_turn
        if stalled_for >= self.stagnation_turns:
            return (
                f"No proposal has been accepted and overall agreement has not "
                f"improved for {stalled_for} turns."
            )
        return None

    # ── Public API ─────────────────────────────────────────────────

    def check(self, turn: int) -> Optional[DeadlockEvidence]:
        """Return evidence if ALL enabled signals fire, else None."""
        if 0 <= self.max_interventions <= self.intervention_count:
            return None
        if (
            self._last_intervention_turn is not None
            and turn - self._last_intervention_turn < self.cooldown_turns
        ):
            return None

        details: Dict[str, str] = {}
        for signal in self.signals:
            if signal == "proposal_stagnation":
                detail = self._check_proposal_stagnation()
            elif signal == "message_repetition":
                detail = self._check_message_repetition()
            else:  # satisfied_stagnation
                detail = self._check_satisfied_stagnation(turn)
            if detail is None:
                return None
            details[signal] = detail

        self._last_intervention_turn = turn
        self.intervention_count += 1
        return DeadlockEvidence(turn=turn, signals=list(self.signals), details=details)

    @staticmethod
    def build_intervention_message(evidence: DeadlockEvidence) -> str:
        return (
            "The discussion appears to be deadlocked. "
            f"{evidence.describe()}\n"
            "To move the meeting forward, on your next turn please do ONE of the "
            "following instead of repeating a previous position:\n"
            "1. Propose a route that is STRUCTURALLY different from the rejected "
            "ones (different destinations or a different overall structure, not a "
            "small tweak).\n"
            "2. State explicitly the minimum concession you can accept, so others "
            "can build a compromise around it.\n"
            "3. If you can live with the currently accepted route, accept it and "
            "declare that you are satisfied.\n"
            "Re-submitting a previously rejected proposal or repeating the same "
            "argument will not resolve the disagreement."
        )

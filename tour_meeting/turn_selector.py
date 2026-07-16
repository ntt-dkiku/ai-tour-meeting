"""Turn selection strategies for free conversation meetings.

Each selector controls the order in which participants speak within a round.
All selectors share a ``satisfied_tracker`` dict (name → bool) that the main
loop writes to; the selector reads it to skip satisfied participants.
"""

from __future__ import annotations

import logging
import random
from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, List, Optional, TYPE_CHECKING

from .participant import NEXT_SPEAKER_FACILITATE_PROMPT

if TYPE_CHECKING:
    from .participant import Participant
    from .messages import HumanMessage, AIMessage

logger = logging.getLogger(__name__)

PhaseCallback = Callable[[str, str], None]


class TurnSelector(ABC):
    """Base class for all turn-selection strategies."""

    def __init__(
        self,
        order: List[str],
        satisfied_tracker: Dict[str, bool],
        volunteer_mode: bool = False,
        balanced_turns: bool = True,
    ) -> None:
        self.order = order
        self.satisfied_tracker = satisfied_tracker
        self.volunteer_mode = volunteer_mode
        self.balanced_turns = balanced_turns
        self._spoken_this_round: List[str] = []
        self.last_llm_calls: List[Dict[str, Any]] = []

    def _available(self) -> List[str]:
        """Return eligible participants for this round.

        When balanced_turns is True (default), only participants who haven't
        spoken this round are eligible.  When False, selection is continuous
        and all participants remain eligible on every turn.
        """
        if not self.balanced_turns:
            return list(self.order)
        return [
            n for n in self.order
            if n not in self._spoken_this_round
            and not self.satisfied_tracker.get(n, False)
        ]

    def start_round(self) -> None:
        """Reset per-round state.  Called at the top of each outer loop."""
        if not self.balanced_turns:
            return
        self._spoken_this_round = []

    @abstractmethod
    async def next_speaker(self) -> Optional[str]:
        """Return the next speaker name, or ``None`` to end the round."""
        ...

    def set_last_speaker(self, name: str) -> None:
        """Override the last speaker for selectors that track it (no-op by default)."""

    def on_turn_complete(self, name: str, conclusion: str, turn_result: Dict[str, Any]) -> None:
        """Notify the selector that *name* has finished their turn."""
        if not self.balanced_turns:
            return
        if name not in self._spoken_this_round:
            self._spoken_this_round.append(name)


# ── Concrete selectors ──────────────────────────────────────────────


class RoundRobinSelector(TurnSelector):
    """Cycle through participants in fixed order, skipping satisfied ones."""

    def start_round(self) -> None:
        super().start_round()
        self._round_order = list(self.order)
        self._index = 0

    async def next_speaker(self) -> Optional[str]:
        while self._index < len(self._round_order):
            name = self._round_order[self._index]
            self._index += 1
            if self.satisfied_tracker.get(name, False):
                continue
            return name
        return None


class RandomSelector(TurnSelector):
    """Shuffle order each round, then iterate like RoundRobin."""

    def start_round(self) -> None:
        if self.balanced_turns:
            super().start_round()
            self._round_order = list(self.order)
            random.shuffle(self._round_order)
            self._index = 0
        else:
            super().start_round()

    async def next_speaker(self) -> Optional[str]:
        if not self.balanced_turns:
            available = self._available()
            if not available:
                return None
            return random.choice(available)
        while self._index < len(self._round_order):
            name = self._round_order[self._index]
            self._index += 1
            if self.satisfied_tracker.get(name, False):
                continue
            return name
        return None


class InvitingSelector(TurnSelector):
    """After each turn, the *current* speaker selects the next one."""

    def __init__(
        self,
        order: List[str],
        satisfied_tracker: Dict[str, bool],
        volunteer_mode: bool = False,
        balanced_turns: bool = True,
        *,
        participant_lookup: Dict[str, "Participant"] = None,
        history_ref: List = None,
        meeting_goal: str = "",
        phase_callback: Optional[PhaseCallback] = None,
        initial_inviter: Optional[str] = None,
    ) -> None:
        super().__init__(order, satisfied_tracker, volunteer_mode, balanced_turns)
        self._participant_lookup = participant_lookup or {}
        self._history_ref = history_ref if history_ref is not None else []
        self._meeting_goal = meeting_goal
        self._phase_callback = phase_callback
        self._last_speaker: Optional[str] = initial_inviter

    def start_round(self) -> None:
        # Preserve _last_speaker across rounds so the previous round's final
        # speaker invites the first speaker of the new round.
        super().start_round()

    def set_last_speaker(self, name: str) -> None:
        """Override the last speaker (e.g. after voting, reset to proposer)."""
        self._last_speaker = name

    async def next_speaker(self) -> Optional[str]:
        self.last_llm_calls = []
        available = self._available()
        if not available:
            return None

        # Very first speaker ever (round 1): use first available in original order
        if self._last_speaker is None:
            name = available[0]
            self._last_speaker = name
            return name

        # Subsequent: previous speaker invites next
        inviter = self._participant_lookup.get(self._last_speaker)
        if inviter is None:
            # Human or missing participant — fallback
            candidates = [n for n in available if n != self._last_speaker] or available
            name = candidates[0]
            self._last_speaker = name
            return name

        try:
            # Exclude inviter from candidates so they can't invite themselves
            candidates = [n for n in available if n != inviter.name] or available
            decision = await inviter.decide_next_speaker(
                other_participant_names=[n for n in self.order if n != inviter.name],
                history=list(self._history_ref),
                available_candidates=candidates,
                meeting_goal=self._meeting_goal,
            )
            self.last_llm_calls = [
                {**c, "speaker": inviter.name} for c in inviter.last_llm_calls
            ]
            chosen = decision.next_speaker
            if chosen not in candidates:
                chosen = candidates[0]
            if self._phase_callback:
                self._phase_callback(
                    "Next Speaker Invitation",
                    f"{inviter.name} invited {chosen} to speak next.\n{decision.message}",
                )
            self._last_speaker = chosen
            return chosen
        except Exception as exc:
            logger.warning("InvitingSelector LLM failed: %s — falling back", exc)
            name = available[0]
            self._last_speaker = name
            return name


class FacilitatingSelector(TurnSelector):
    """A designated facilitator chooses the next speaker every turn."""

    def __init__(
        self,
        order: List[str],
        satisfied_tracker: Dict[str, bool],
        volunteer_mode: bool = False,
        balanced_turns: bool = True,
        *,
        participant_lookup: Dict[str, "Participant"] = None,
        history_ref: List = None,
        meeting_goal: str = "",
        phase_callback: Optional[PhaseCallback] = None,
        facilitator_name: Optional[str] = None,
        facilitator_is_human: bool = False,
        initial_inviter: Optional[str] = None,
    ) -> None:
        super().__init__(order, satisfied_tracker, volunteer_mode, balanced_turns)
        self._participant_lookup = participant_lookup or {}
        self._history_ref = history_ref if history_ref is not None else []
        self._meeting_goal = meeting_goal
        self._phase_callback = phase_callback
        self._facilitator_name = facilitator_name
        # When the designated facilitator is the human participant, the LLM
        # cannot pick — the main loop drives the choice through the UI (see
        # candidates()/record_choice()). next_speaker() then only runs for the
        # non-human path, falling back to round robin if ever called.
        self.facilitator_is_human = facilitator_is_human
        self._initial_inviter = initial_inviter
        self._first_call = True
        self._last_chosen: Optional[str] = None  # Track last chosen to avoid consecutive repeats
        # fallback selector when no facilitator found
        self._fallback: Optional[RoundRobinSelector] = None

    def start_round(self) -> None:
        super().start_round()
        if self._fallback:
            self._fallback.start_round()

    def candidates(self) -> List[str]:
        """The participants the facilitator may pick from this turn.

        Excludes the last chosen speaker (to avoid consecutive repeats). The
        facilitator themselves stays eligible — a human facilitator may take the
        floor, mirroring how an LLM facilitator can pick itself. Returns ``[]``
        when the round is exhausted. Used by the main loop to drive the
        human-facilitator UI without duplicating next_speaker()'s eligibility
        logic.
        """
        available = self._available()
        if not available:
            return []
        return [n for n in available if n != self._last_chosen] or available

    def record_choice(self, chosen: str) -> None:
        """Record an externally-made choice (e.g. the human facilitator's pick)."""
        self._last_chosen = chosen
        self._first_call = False

    async def next_speaker(self) -> Optional[str]:
        self.last_llm_calls = []
        available = self._available()
        if not available:
            return None

        # On the first call, use initial_inviter if provided (e.g. proposer
        # choosing the first voter), even if they are not in the voter order.
        chooser_name = self._facilitator_name
        if self._first_call and self._initial_inviter:
            chooser_name = self._initial_inviter
            self._first_call = False
        else:
            self._first_call = False

        facilitator = (
            None if self.facilitator_is_human
            else self._participant_lookup.get(chooser_name or "")
        )
        if facilitator is None:
            # No facilitator found — fallback to round robin
            if self._fallback is None:
                self._fallback = RoundRobinSelector(
                    self.order, self.satisfied_tracker, self.volunteer_mode,
                    self.balanced_turns,
                )
                self._fallback.start_round()
            return await self._fallback.next_speaker()

        try:
            # Exclude the last chosen person to avoid consecutive repeats
            candidates = [n for n in available if n != self._last_chosen] or available
            decision = await facilitator.decide_next_speaker(
                other_participant_names=[n for n in self.order if n != facilitator.name],
                history=list(self._history_ref),
                available_candidates=candidates,
                meeting_goal=self._meeting_goal,
                prompt_template=NEXT_SPEAKER_FACILITATE_PROMPT,
            )
            self.last_llm_calls = [
                {**c, "speaker": facilitator.name} for c in facilitator.last_llm_calls
            ]
            chosen = decision.next_speaker
            if chosen not in candidates:
                chosen = candidates[0]
            self._last_chosen = chosen
            if self._phase_callback:
                self._phase_callback(
                    "Facilitator Selected Next Speaker",
                    f"{facilitator.name} invited {chosen} to speak next.\n{decision.message}",
                )
            return chosen
        except Exception as exc:
            logger.warning("FacilitatingSelector LLM failed: %s — falling back", exc)
            return available[0]


# ── Factory ──────────────────────────────────────────────────────────


def create_selector(
    turn_rule: str,
    order: List[str],
    satisfied_tracker: Dict[str, bool],
    volunteer_mode: bool = False,
    balanced_turns: bool = True,
    *,
    participant_lookup: Optional[Dict[str, "Participant"]] = None,
    history_ref: Optional[List] = None,
    meeting_goal: str = "",
    phase_callback: Optional[PhaseCallback] = None,
    initial_inviter: Optional[str] = None,
    human_facilitator_key: Optional[str] = None,
) -> TurnSelector:
    """Instantiate the appropriate selector for *turn_rule*."""

    common = dict(
        order=order,
        satisfied_tracker=satisfied_tracker,
        volunteer_mode=volunteer_mode,
        balanced_turns=balanced_turns,
    )
    extra = dict(
        participant_lookup=participant_lookup or {},
        history_ref=history_ref if history_ref is not None else [],
        meeting_goal=meeting_goal,
        phase_callback=phase_callback,
    )

    if turn_rule == "round_robin":
        return RoundRobinSelector(**common)
    elif turn_rule == "random":
        return RandomSelector(**common)
    elif turn_rule == "inviting":
        return InvitingSelector(**common, **extra, initial_inviter=initial_inviter)
    elif turn_rule == "facilitating":
        # The human facilitator (if any) takes precedence; the main loop drives
        # their pick through the UI. Otherwise, find the first LLM participant
        # with role == "facilitator".
        facilitator_name: Optional[str] = None
        facilitator_is_human = False
        if human_facilitator_key and human_facilitator_key in order:
            facilitator_name = human_facilitator_key
            facilitator_is_human = True
        elif participant_lookup:
            for name, p in participant_lookup.items():
                if getattr(p, "role", "").lower() == "facilitator":
                    facilitator_name = name
                    break
        return FacilitatingSelector(
            **common,
            **extra,
            facilitator_name=facilitator_name,
            facilitator_is_human=facilitator_is_human,
            initial_inviter=initial_inviter,
        )
    else:
        logger.warning("Unknown turn_rule '%s', defaulting to round_robin", turn_rule)
        return RoundRobinSelector(**common)

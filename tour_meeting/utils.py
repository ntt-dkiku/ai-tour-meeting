from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from .types import (
    AskExchange,
    Delta,
    MeetingFinished,
    MeetingStarted,
    PhaseMessage,
    ProposalVoteResult,
    RoundEnd,
    Timeout,
    TurnFinal,
    TurnStart,
)


_CURRENCY_SYMBOL_RE = re.compile(r"([$¥€£₩₹₫₪฿])\s*\d")
_YEN_SUFFIX_RE = re.compile(r"\d\s*円")
_COST_NUMBER_RE = re.compile(r"([-+]?\d[\d,\.]*)")


def parse_cost_amount(text: Optional[str]) -> Optional[Tuple[str, float]]:
    """Parse a cost string into ``(currency_symbol, amount)``.

    The symbol is ``''`` when no recognizable currency is present
    ('500円' counts as '¥'). Returns None when the string carries no number.
    """
    if not text or not isinstance(text, str):
        return None
    match = _COST_NUMBER_RE.search(text)
    if not match:
        return None
    try:
        amount = float(match.group(1).replace(",", ""))
    except ValueError:
        return None
    sym_match = _CURRENCY_SYMBOL_RE.search(text)
    if sym_match:
        return sym_match.group(1), amount
    if _YEN_SUFFIX_RE.search(text):
        return "¥", amount
    return "", amount


def sum_costs_by_currency(texts: List[Optional[str]]) -> Dict[str, float]:
    """Sum cost strings per currency, keyed by symbol in first-seen order."""
    totals: Dict[str, float] = {}
    for text in texts:
        parsed = parse_cost_amount(text)
        if parsed is None:
            continue
        symbol, amount = parsed
        totals[symbol] = totals.get(symbol, 0.0) + amount
    return totals


def format_cost_totals(texts: List[Optional[str]]) -> Optional[str]:
    """Sum cost strings per currency, e.g. '¥2,300' or '$20 + ¥1,500'.

    Mixed currencies are kept separate (never added together) and listed in
    first-seen order. Returns None when nothing sums to a non-zero total.
    """
    totals = sum_costs_by_currency(texts)
    parts = [f"{symbol}{int(amount):,}" for symbol, amount in totals.items() if amount]
    return " + ".join(parts) if parts else None


def format_event(event: Any) -> Optional[str]:
    """Return a human-readable one-liner for a meeting event, or None to skip."""
    if isinstance(event, MeetingStarted):
        return f"[meeting_started] goal={event.goal[:60]}..."
    if isinstance(event, TurnStart):
        return f"\n--- Turn {event.turn} [{event.speaker}] ---"
    if isinstance(event, Delta):
        if event.delta:
            return event.delta
        meta = event.metadata or {}
        ie = meta.get("internal_event", {})
        et = ie.get("event_type", "")
        if et == "thinking_step":
            return f"  [Step {ie.get('step_number','?')}/{ie.get('max_steps','?')} - {ie.get('action','')}]"
        return None
    if isinstance(event, TurnFinal):
        label = event.steps_label or ""
        score = event.score
        suffix = f" (score={score})" if score is not None else ""
        suffix += f" [{label}]" if label else ""
        return f"  << final{suffix} >>"
    if isinstance(event, ProposalVoteResult):
        return f"\n[vote_result] accepted={event.accepted}"
    if isinstance(event, PhaseMessage):
        return f"\n[phase] {event.title}"
    if isinstance(event, AskExchange):
        return f"  [ask] {event.asker} -> {event.target}: {event.question[:50]}..."
    if isinstance(event, RoundEnd):
        return f"\n=== Round {event.round_number} ended ==="
    if isinstance(event, Timeout):
        return "\n[timeout]"
    if isinstance(event, MeetingFinished):
        return f"\n[meeting_finished] turns={event.turns}"
    return None

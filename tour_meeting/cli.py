"""CLI / script helpers for building and running tour meetings."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Set, Union

from .llm import load_llm
from .participant import Participant
from .tour_meeting import AITourMeeting

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Validation constants
# ---------------------------------------------------------------------------

_REQUIRED_PARTICIPANT_KEYS = {
    "name", "model_name", "background", "personality", "preferences", "personal_goals",
}

_VALID_ROLES = {"facilitator", "attendee"}
_VALID_EXPLANATION_STYLES = {"auto", "subjective", "contrastive", "both"}
_VALID_CONTEXT_MODES = {"auto_compact", "truncate", "fixed_turns", "none"}

_KNOWN_PARTICIPANT_KEYS: Set[str] = (
    _REQUIRED_PARTICIPANT_KEYS
    | {
        "temperature", "seed", "max_tokens", "max_context_length", "reasoning_effort",
        "role", "speaking_style", "explanation_style", "web_search", "max_steps",
        "context_mode", "auto_compact_threshold", "auto_compact_target",
        "compact_recent_ratio", "fixed_turns_count", "system_prompt",
    }
)


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _validate_participant(idx: int, cfg: Dict[str, Any]) -> None:
    """Validate a single participant config dict. Raises ValueError on error."""
    label = cfg.get("name", f"participants[{idx}]")

    # Required keys
    missing = _REQUIRED_PARTICIPANT_KEYS - cfg.keys()
    if missing:
        raise ValueError(f"Participant '{label}': missing required keys: {sorted(missing)}")

    # Type checks for required string fields
    for key in ("name", "model_name", "background", "personality", "preferences", "personal_goals"):
        val = cfg[key]
        if not isinstance(val, str) or not val.strip():
            raise ValueError(f"Participant '{label}': '{key}' must be a non-empty string, got {val!r}")

    # Enum-like value checks
    if "role" in cfg and cfg["role"] not in _VALID_ROLES:
        raise ValueError(
            f"Participant '{label}': invalid role {cfg['role']!r}, "
            f"must be one of {sorted(_VALID_ROLES)}"
        )
    if "speaking_style" in cfg:
        if not isinstance(cfg["speaking_style"], str) or not cfg["speaking_style"].strip():
            raise ValueError(
                f"Participant '{label}': speaking_style must be a non-empty string, got {cfg['speaking_style']!r}"
            )
    if "system_prompt" in cfg and cfg["system_prompt"] is not None:
        if not isinstance(cfg["system_prompt"], str):
            raise ValueError(
                f"Participant '{label}': system_prompt must be a string or null, "
                f"got {cfg['system_prompt']!r}"
            )
    if "explanation_style" in cfg and cfg["explanation_style"] not in _VALID_EXPLANATION_STYLES:
        raise ValueError(
            f"Participant '{label}': invalid explanation_style {cfg['explanation_style']!r}, "
            f"must be one of {sorted(_VALID_EXPLANATION_STYLES)}"
        )
    if "context_mode" in cfg and cfg["context_mode"] not in _VALID_CONTEXT_MODES:
        raise ValueError(
            f"Participant '{label}': invalid context_mode {cfg['context_mode']!r}, "
            f"must be one of {sorted(_VALID_CONTEXT_MODES)}"
        )

    # Numeric range checks
    if "temperature" in cfg:
        t = cfg["temperature"]
        if not isinstance(t, (int, float)) or t < 0:
            raise ValueError(f"Participant '{label}': temperature must be a non-negative number, got {t!r}")
    if "max_steps" in cfg:
        v = cfg["max_steps"]
        if not isinstance(v, int) or v < 1:
            raise ValueError(f"Participant '{label}': max_steps must be a positive integer, got {v!r}")
    if "seed" in cfg:
        v = cfg["seed"]
        if not isinstance(v, int):
            raise ValueError(f"Participant '{label}': seed must be an integer, got {v!r}")
    for key in ("auto_compact_threshold", "auto_compact_target", "compact_recent_ratio"):
        if key in cfg:
            v = cfg[key]
            if not isinstance(v, (int, float)) or not (0 <= v <= 1):
                raise ValueError(f"Participant '{label}': {key} must be a number between 0 and 1, got {v!r}")

    # Warn about unknown keys
    unknown = cfg.keys() - _KNOWN_PARTICIPANT_KEYS
    if unknown:
        import warnings
        warnings.warn(
            f"Participant '{label}': unknown keys ignored: {sorted(unknown)}",
            stacklevel=3,
        )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_meeting(
    title: str,
    global_goals: str,
    participants: List[Dict[str, Any]],
    constraints: Optional[Union[str, Dict[str, Any]]] = None,
    settings: Optional[Dict[str, Any]] = None,
) -> AITourMeeting:
    """Build an AITourMeeting from participant config dicts.

    Each participant dict should contain:
      Required: name, model_name, background, personality, preferences, personal_goals
      Optional: temperature, seed, max_tokens, max_context_length,
                role, speaking_style, explanation_style, web_search, max_steps,
                context_mode, auto_compact_threshold, auto_compact_target,
                compact_recent_ratio, fixed_turns_count, system_prompt

    ``system_prompt``, when a non-empty string, fully replaces the default
    participant system prompt (SYS_PARTICIPANT). It may use the same
    ``{placeholder}`` tokens; unused/unknown braces are left literal.

    Raises:
        ValueError: If required keys are missing or values are invalid.
    """
    if not participants:
        raise ValueError("participants list must not be empty")

    for i, cfg in enumerate(participants):
        _validate_participant(i, cfg)

    meeting = AITourMeeting(
        title=title,
        global_goals=global_goals,
        constraints=constraints,
        settings=settings,
    )
    for cfg in participants:
        llm = load_llm(
            model_name=cfg["model_name"],
            temperature=cfg.get("temperature", 0.7),
            seed=cfg.get("seed", 42),
            max_tokens=cfg.get("max_tokens"),
            max_context_length=cfg.get("max_context_length"),
            reasoning_effort=cfg.get("reasoning_effort"),
        )
        p = Participant(
            llm=llm,
            name=cfg["name"],
            background=cfg["background"],
            personality=cfg["personality"],
            preferences=cfg["preferences"],
            personal_goals=cfg["personal_goals"],
            role=cfg.get("role", "attendee"),
            speaking_style=cfg.get("speaking_style", "friendly"),
            explanation_style=cfg.get("explanation_style", "auto"),
            web_search=cfg.get("web_search", False),
            max_steps=cfg.get("max_steps", 5),
            context_mode=cfg.get("context_mode", "auto_compact"),
            auto_compact_threshold=cfg.get("auto_compact_threshold", 0.8),
            auto_compact_target=cfg.get("auto_compact_target", 0.5),
            compact_recent_ratio=cfg.get("compact_recent_ratio", 0.7),
            fixed_turns_count=cfg.get("fixed_turns_count", 10),
            system_prompt=cfg.get("system_prompt"),
        )
        meeting.add_participant(p)
    return meeting

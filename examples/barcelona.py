#!/usr/bin/env python3
"""Create and run a 3-participant Barcelona tour meeting using the Python module directly.

Usage:
    python examples/barcelona.py [--max-turns 20] [--model openai/gpt-5-mini-2025-08-07]

No running backend server required -- this drives AITourMeeting in-process.
"""
from __future__ import annotations

import argparse
import asyncio
from typing import Any, Dict, List

from tour_meeting.cli import build_meeting


# ---------------------------------------------------------------------------
# Meeting definition
# ---------------------------------------------------------------------------

TITLE = "Cultural Expedition: A One-Day Tour in Barcelona"

GLOBAL_GOAL = "Plan an engaging one-day walking tour that balances cultural, culinary, and personal interaction experiences in Barcelona."

PARTICIPANTS: List[Dict[str, Any]] = [
    {
        "name": "Isabella Chen",
        "background": (
            "A passionate art historian from Taiwan with a deep academic interest "
            "in local cultures and the little-known stories behind famous landmarks."
        ),
        "personality": "Detail-oriented and tends to be a bit traditional in her tour preferences.",
        "preferences": "Prefers guided tours and museums over open-ended exploration.",
        "personal_goals": (
            "To visit lesser-known galleries and historical landmarks, "
            "ensuring a deep, enriching cultural experience."
        ),
        "role": "facilitator",
        "speaking_style": "friendly",
        "explanation_style": "auto",
        "model_name": "vllm/0/Qwen/Qwen3-8B",
        "temperature": 0.7,
        "seed": 42,
        "web_search": False,
        "max_steps": 5,
        "max_tokens": 8192,
        "max_context_length": 32768,
        "context_mode": "auto_compact",
        "auto_compact_threshold": 0.8,
        "auto_compact_target": 0.5,
        "compact_recent_ratio": 0.7,
        # "fixed_turns_count": 10,
    },
    {
        "name": "Luca Ferraro",
        "background": "A food blogger from Italy who writes about street food and local cuisine.",
        "personality": "Adventurous and spontaneous.",
        "preferences": "Prefers exploring food markets and tasting dishes over following strict itineraries.",
        "personal_goals": (
            "To sample authentic Catalan street food and visit the famous "
            "La Boqueria market."
        ),
        "role": "attendee",
        "speaking_style": "enthusiastic",
        "explanation_style": "auto",
        "model_name": "vllm/0/Qwen/Qwen3-8B",
        "temperature": 0.7,
        "seed": 42,
        "web_search": False,
        "max_steps": 5,
        "max_tokens": 8192,
        "max_context_length": 32768,
        "context_mode": "auto_compact",
        "auto_compact_threshold": 0.8,
        "auto_compact_target": 0.5,
        "compact_recent_ratio": 0.7,
        # "fixed_turns_count": 10,
    },
    {
        "name": "Amina Al-Mansoori",
        "background": "A digital nomad from the UAE who has traveled extensively and enjoys finding hidden gems in cities.",
        "personality": "Extroverted and loves cultural exchanges.",
        "preferences": "Prioritizes meeting locals and social interactions over conventional sightseeing.",
        "personal_goals": (
            "To meet local artists and explore small, community-driven "
            "projects while visiting iconic sites."
        ),
        "role": "attendee",
        "speaking_style": "supportive",
        "explanation_style": "auto",
        "model_name": "vllm/0/Qwen/Qwen3-8B",
        "temperature": 0.7,
        "seed": 42,
        "web_search": False,
        "max_steps": 5,
        "max_tokens": 8192,
        "max_context_length": 32768,
        "context_mode": "auto_compact",
        "auto_compact_threshold": 0.8,
        "auto_compact_target": 0.5,
        "compact_recent_ratio": 0.7,
        # "fixed_turns_count": 10,
    },
]

SETTINGS: Dict[str, Any] = {
    "turn_rule": "round_robin",
    "vote_turn_rule": "round_robin",
    "voting_rule": "majority",
    "max_turns": 100,
    "time_limit": None,
    "volunteer_mode": False,
    "balanced_turns": True,
}

CONSTRAINTS: Dict[str, Any] = {
    "travel_date": "2023-06-15",
    "time_window_start": "09:00",
    "time_window_end": "18:00",
    "budget": "$600",
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Run a Barcelona 3-participant meeting")
    parser.add_argument(
        "--max-turns",
        type=int,
        default=SETTINGS["max_turns"],
        help=f"Maximum number of turns (default: {SETTINGS['max_turns']})",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Override model for all participants (e.g. openai/gpt-5-mini-2025-08-07)",
    )
    args = parser.parse_args()

    participants = PARTICIPANTS
    if args.model:
        participants = [{**cfg, "model_name": args.model} for cfg in PARTICIPANTS]

    settings = {**SETTINGS, "max_turns": args.max_turns}
    meeting = build_meeting(TITLE, GLOBAL_GOAL, participants, CONSTRAINTS, settings)
    asyncio.run(meeting.run_cli())


if __name__ == "__main__":
    main()

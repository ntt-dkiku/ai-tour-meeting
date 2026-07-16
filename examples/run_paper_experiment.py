#!/usr/bin/env python3
"""Run meeting(s) from an existing JSON file.

Usage:
    make run SCRIPT=examples/run_meeting.py ARGS='--input results/generated.json'
    make run SCRIPT=examples/run_meeting.py ARGS='--input results/generated.json --model openai/gpt-5-mini-2025-08-07'
    make run SCRIPT=examples/run_meeting.py ARGS='--input results/generated.json --max-turns 20'

No running backend server required -- this drives AITourMeeting in-process.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

from tour_meeting.cli import build_meeting


# ---------------------------------------------------------------------------
# Default runtime config (applied to every participant)
# ---------------------------------------------------------------------------

DEFAULT_PARTICIPANT_CONFIG: Dict[str, Any] = {
    "model_name": "vllm/0/Qwen/Qwen3-8B",
    "temperature": 0.7,
    "reasoning_effort": None,
    "seed": 42,
    "web_search": False,
    "max_steps": 10,
    "max_tokens": 8192,
    "max_context_length": 32768,
    "context_mode": "auto_compact",
    "auto_compact_threshold": 0.8,
    "auto_compact_target": 0.5,
    "compact_recent_ratio": 0.7,
}

SETTINGS: Dict[str, Any] = {
    "turn_rule": "inviting",
    "vote_turn_rule": "inviting",
    "voting_rule": "majority",
    "max_turns": 100,
    "time_limit": None,
    "volunteer_mode": False,
    "balanced_turns": True,
    # Deadlock detection+intervention is opt-in for experiments so the
    # baseline dynamics stay unmodified.
    "deadlock_detection": {"enabled": False},
}

CONSTRAINTS: Dict[str, Any] = {
    "travel_date": "2026-03-15",
    "time_window_start": "09:00",
    "time_window_end": "18:00",
    "budget": "$100",
}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _build(config: Dict[str, Any], model_override: str | None, max_turns: int):
    """Build an AITourMeeting from a config dict."""
    participants: List[Dict[str, Any]] = []
    for p in config["participants"]:
        merged = {**DEFAULT_PARTICIPANT_CONFIG, **p}
        if model_override:
            merged["model_name"] = model_override
        participants.append(merged)

    settings = {**SETTINGS, "max_turns": max_turns}
    return build_meeting(
        config["title"],
        config["global_goals"],
        participants,
        CONSTRAINTS,
        settings,
    )


def _serialize_history(history) -> List[Dict[str, Any]]:
    """Convert meeting history (HumanMessage/AIMessage) to JSON-serializable list."""
    result = []
    for msg in history:
        result.append({
            "role": msg.type,
            "name": msg.name,
            "content": msg.content,
        })
    return result


def _output_path(input_path: str, model_name: str) -> Path:
    """Build output path: result_<model>_<inputfile>.json in the same directory."""
    p = Path(input_path)
    # Strip GPU index from vLLM model names: vllm/0/Qwen/Qwen3-8B -> vllm/Qwen/Qwen3-8B
    import re
    clean_model = re.sub(r"^(vllm)/\d+/", r"\1/", model_name)
    safe_model = clean_model.replace("/", "_")
    return p.parent / f"result_{safe_model}_{p.name}"


def _save(output_path: Path, configs: List[Dict[str, Any]]) -> None:
    """Save configs with results to output file."""
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({"meetings": configs}, f, indent=2, ensure_ascii=False)


def main(args) -> None:
    print(f"[+] Loading scenarios from {args.input} ...", file=sys.stderr)
    with open(args.input, encoding="utf-8") as f:
        configs = json.load(f)["meetings"]

    model_name = args.model or DEFAULT_PARTICIPANT_CONFIG["model_name"]
    output_path = Path(args.output) if args.output else _output_path(args.input, model_name)
    num_parallel = args.num_parallel

    if num_parallel <= 1:
        # Sequential
        for i, config in enumerate(configs):
            names = ", ".join(p["name"] for p in config["participants"])
            print(f"[+] Running meeting {i + 1}/{len(configs)}: {config['title']} "
                  f"({len(config['participants'])} participants: {names})",
                  file=sys.stderr)
            meeting = _build(config, args.model, args.max_turns)
            asyncio.run(meeting.run_cli())
            config["results"] = {
                **meeting.export_analytics(),
                "conversation_history": _serialize_history(meeting.history),
            }
            _save(output_path, configs)
            print(f"[+] Saved to {output_path} ({i + 1}/{len(configs)})",
                  file=sys.stderr)
    else:
        # Parallel
        async def _run_one(sem: asyncio.Semaphore, idx: int, config: Dict[str, Any]):
            async with sem:
                names = ", ".join(p["name"] for p in config["participants"])
                print(f"[+] Running meeting {idx + 1}/{len(configs)}: {config['title']} "
                      f"({len(config['participants'])} participants: {names})",
                      file=sys.stderr)
                meeting = _build(config, args.model, args.max_turns)
                await meeting.run_cli()
                config["results"] = {
                    **meeting.export_analytics(),
                    "conversation_history": _serialize_history(meeting.history),
                }
                _save(output_path, configs)
                print(f"[+] Saved to {output_path}", file=sys.stderr)

        async def _run_all():
            sem = asyncio.Semaphore(num_parallel)
            tasks = [_run_one(sem, i, c) for i, c in enumerate(configs)]
            await asyncio.gather(*tasks)

        print(f"[+] Running {len(configs)} meetings with parallelism={num_parallel}",
              file=sys.stderr)
        asyncio.run(_run_all())

    print(f"[+] All done. Results: {output_path}", file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Run meeting(s) from an existing JSON file",
    )
    parser.add_argument(
        "--input", "-i",
        required=True,
        help="Path to JSON file with meetings (e.g. results/generated.json)",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Override model for all participants at runtime",
    )
    parser.add_argument(
        "--max-turns",
        type=int,
        default=SETTINGS["max_turns"],
        help=f"Maximum number of turns (default: {SETTINGS['max_turns']})",
    )
    parser.add_argument(
        "--num-parallel",
        type=int,
        default=1,
        help="Number of meetings to run in parallel (default: 1 = sequential)",
    )
    parser.add_argument(
        "--turn-rule",
        default=None,
        help="Override turn_rule in settings (e.g. 'inviting', 'round_robin', 'random')",
    )
    parser.add_argument(
        "--vote-turn-rule",
        default=None,
        help="Override vote_turn_rule in settings (e.g. 'parallel', 'inviting', 'round_robin')",
    )
    parser.add_argument(
        "--output", "-o",
        default=None,
        help="Override output JSON path (default: auto-generated from input + model)",
    )
    parser.add_argument(
        "--voting-rule",
        default=None,
        help="Override voting_rule (majority, unanimous, most_pleasure, least_misery, single_decider)",
    )
    parser.add_argument(
        "--balanced-turns",
        default=None,
        choices=["true", "false"],
        help="Override balanced_turns (true=everyone speaks each round, false=free speaking)",
    )
    parser.add_argument(
        "--volunteer-mode",
        default=None,
        choices=["true", "false"],
        help="Override volunteer_mode (true=participants can pass, false=must act)",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=None,
        help=f"Override sampling temperature for all participants "
             f"(default: {DEFAULT_PARTICIPANT_CONFIG['temperature']})",
    )
    parser.add_argument(
        "--reasoning-effort",
        default=None,
        help="Override reasoning effort for all participants (e.g. 'none', 'low', 'medium', 'high'; "
             "default: not sent, provider default applies)",
    )
    parser.add_argument(
        "--deadlock-detection",
        default="false",
        choices=["true", "false"],
        help="Enable deadlock detection + System intervention (default: false)",
    )
    args = parser.parse_args()

    if args.temperature is not None:
        DEFAULT_PARTICIPANT_CONFIG["temperature"] = args.temperature
    if args.reasoning_effort is not None:
        DEFAULT_PARTICIPANT_CONFIG["reasoning_effort"] = args.reasoning_effort
    SETTINGS["deadlock_detection"] = {"enabled": args.deadlock_detection == "true"}

    if args.turn_rule:
        SETTINGS["turn_rule"] = args.turn_rule
    if args.vote_turn_rule:
        SETTINGS["vote_turn_rule"] = args.vote_turn_rule
    if args.voting_rule:
        SETTINGS["voting_rule"] = args.voting_rule
    if args.balanced_turns is not None:
        SETTINGS["balanced_turns"] = args.balanced_turns == "true"
    if args.volunteer_mode is not None:
        SETTINGS["volunteer_mode"] = args.volunteer_mode == "true"

    main(args)

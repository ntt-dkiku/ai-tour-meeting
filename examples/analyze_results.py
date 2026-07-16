#!/usr/bin/env python3
"""Analyze meeting experiment results and print a summary report.

Usage:
    python examples/analyze_results.py results/result_vllm_Qwen_Qwen3-8B_meetings_p3_n50.json
    python examples/analyze_results.py results/result_*.json   # multiple files
"""

import json
import sys
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List


def load_completed(path: str) -> List[Dict[str, Any]]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return [m for m in data["meetings"] if "results" in m]


def section(title: str) -> None:
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}")


def subsection(title: str) -> None:
    print(f"\n--- {title} ---")


def fmt_stats(values: List[float], unit: str = "") -> str:
    if not values:
        return "N/A"
    u = f" {unit}" if unit else ""
    if len(values) == 1:
        return f"{values[0]:.1f}{u}"
    return (
        f"mean={statistics.mean(values):.1f}{u}, "
        f"median={statistics.median(values):.1f}{u}, "
        f"std={statistics.stdev(values):.1f}{u}, "
        f"min={min(values):.1f}{u}, max={max(values):.1f}{u}"
    )


def analyze_file(path: str) -> None:
    meetings = load_completed(path)
    if not meetings:
        print(f"No completed meetings in {path}")
        return

    n = len(meetings)
    section(f"{Path(path).name}  ({n} meetings)")

    # ------------------------------------------------------------------
    # 1. Basic stats
    # ------------------------------------------------------------------
    subsection("1. Overview")
    durations = []
    reasons = Counter()
    turn_counts = []
    conversation_lengths = []

    for m in meetings:
        r = m["results"]
        meta = r.get("metadata", {})
        st, et = meta.get("start_time"), meta.get("end_time")
        if st and et:
            durations.append(et - st)
        reasons[meta.get("termination_reason", "unknown")] += 1

        # Turn count from conversation history
        conv = r.get("conversation_history", [])
        conversation_lengths.append(len(conv))

        # Turns per agent
        dd = r.get("discussion_dynamics", {}).get("activity", {})
        tpa = dd.get("turns_per_agent", {})
        if tpa:
            turn_counts.append(sum(tpa.values()))

    print(f"  Meetings completed: {n}")
    print(f"  Duration: {fmt_stats(durations, 's')}")
    if durations:
        print(f"           ({fmt_stats([d / 60 for d in durations], 'min')})")
    print(f"  Conversation messages: {fmt_stats([float(x) for x in conversation_lengths])}")
    print(f"  Termination reasons: {dict(reasons)}")

    # ------------------------------------------------------------------
    # 2. Token usage
    # ------------------------------------------------------------------
    subsection("2. Token Usage")
    total_prompt = []
    total_completion = []
    calls_per_meeting = []

    for m in meetings:
        calls = m["results"].get("discussion_dynamics", {}).get("activity", {}).get("llm_calls", [])
        calls_per_meeting.append(len(calls))
        pt = sum(c.get("prompt_tokens", 0) for c in calls)
        ct = sum(c.get("completion_tokens", 0) for c in calls)
        total_prompt.append(pt)
        total_completion.append(ct)

    print(f"  LLM calls/meeting: {fmt_stats([float(x) for x in calls_per_meeting])}")
    print(f"  Prompt tokens/meeting: {fmt_stats([float(x) for x in total_prompt])}")
    print(f"  Completion tokens/meeting: {fmt_stats([float(x) for x in total_completion])}")
    if total_prompt and total_completion:
        total_all = [p + c for p, c in zip(total_prompt, total_completion)]
        print(f"  Total tokens/meeting: {fmt_stats([float(x) for x in total_all])}")

    # ------------------------------------------------------------------
    # 3. Action distribution
    # ------------------------------------------------------------------
    subsection("3. Action Distribution (across all meetings)")
    global_actions = Counter()
    action_per_meeting = defaultdict(list)

    for m in meetings:
        ac = m["results"].get("discussion_dynamics", {}).get("activity", {}).get("action_counts", {})
        meeting_totals = Counter()
        for agent, actions in ac.items():
            for action, count in actions.items():
                global_actions[action] += count
                meeting_totals[action] += count
        for action in global_actions:
            action_per_meeting[action].append(meeting_totals.get(action, 0))

    total_actions = sum(global_actions.values())
    if total_actions:
        for action, count in global_actions.most_common():
            pct = count / total_actions * 100
            per_meeting = action_per_meeting[action]
            print(f"  {action:>12}: {count:5d} ({pct:5.1f}%)  per-meeting: {fmt_stats([float(x) for x in per_meeting])}")

    # ------------------------------------------------------------------
    # 4. Satisfied progression
    # ------------------------------------------------------------------
    subsection("4. Consensus Convergence")
    turns_to_consensus = []
    first_satisfied_turn = []
    voting_rounds = []

    for m in meetings:
        r = m["results"]
        sp = r.get("satisfied_progression", [])
        if sp:
            first_satisfied_turn.append(sp[0]["turn"])
            # Last entry where satisfied_count == total_count
            for entry in reversed(sp):
                if entry["satisfied_count"] == entry["total_count"]:
                    turns_to_consensus.append(entry["turn"])
                    break

        # Voting rounds = number of proposals in history
        ph = r.get("discussion_dynamics", {}).get("proposals", {}).get("proposals_history", [])
        voting_rounds.append(len(ph))

    print(f"  First 'satisfied' action at turn: {fmt_stats([float(x) for x in first_satisfied_turn])}")
    print(f"  Full consensus at turn: {fmt_stats([float(x) for x in turns_to_consensus])}")
    print(f"  Voting rounds/meeting: {fmt_stats([float(x) for x in voting_rounds])}")

    # ------------------------------------------------------------------
    # 5. Proposals & Voting
    # ------------------------------------------------------------------
    subsection("5. Proposals & Voting")
    mods_per_meeting = []
    accept_rate = []
    approval_counts = []
    reject_counts = []

    for m in meetings:
        dd = m["results"].get("discussion_dynamics", {})
        props = dd.get("proposals", {})
        mods = props.get("modifications_per_agent", {})
        accepted = props.get("accepted_modifications_per_agent", {})
        total_mods = sum(mods.values())
        total_accepted = sum(accepted.values())
        mods_per_meeting.append(total_mods)
        if total_mods > 0:
            accept_rate.append(total_accepted / total_mods * 100)

        cons = dd.get("consensus", {})
        a = sum(cons.get("approval_votes_per_agent", {}).values())
        r_ = sum(cons.get("reject_votes_per_agent", {}).values())
        approval_counts.append(a)
        reject_counts.append(r_)

    print(f"  Route modifications/meeting: {fmt_stats([float(x) for x in mods_per_meeting])}")
    print(f"  Acceptance rate: {fmt_stats(accept_rate, '%')}")
    print(f"  Approval votes/meeting: {fmt_stats([float(x) for x in approval_counts])}")
    print(f"  Reject votes/meeting: {fmt_stats([float(x) for x in reject_counts])}")

    # ------------------------------------------------------------------
    # 6. Route characteristics
    # ------------------------------------------------------------------
    subsection("6. Route Characteristics")
    final_dest_counts = []
    final_costs = []
    final_travel_times = []
    time_correction_counts = []
    unique_destinations_proposed = []

    for m in meetings:
        rc = m["results"].get("route_characteristics", {})
        snaps = rc.get("route_snapshots", [])
        accepted = [s for s in snaps if s.get("phase") == "accepted"]
        if accepted:
            last = accepted[-1]
            final_dest_counts.append(last.get("num_destinations", 0))
            final_costs.append(last.get("cost", 0))
            final_travel_times.append(last.get("travel_time", 0))

        tc = rc.get("time_corrections", [])
        time_correction_counts.append(len(tc))

        proposed = rc.get("all_proposed_destinations", [])
        unique_destinations_proposed.append(len(proposed))

    print(f"  Final destinations/route: {fmt_stats([float(x) for x in final_dest_counts])}")
    print(f"  Final cost ($): {fmt_stats([float(x) for x in final_costs])}")
    print(f"  Final travel time (min): {fmt_stats([float(x) for x in final_travel_times])}")
    print(f"  Time corrections/meeting: {fmt_stats([float(x) for x in time_correction_counts])}")
    print(f"  Unique destinations proposed: {fmt_stats([float(x) for x in unique_destinations_proposed])}")

    # ------------------------------------------------------------------
    # 7. Context compaction
    # ------------------------------------------------------------------
    subsection("7. Context Compaction")
    compaction_counts = []
    tokens_saved = []

    for m in meetings:
        events = m["results"].get("discussion_dynamics", {}).get("activity", {}).get("compaction_events", [])
        compaction_counts.append(len(events))
        for e in events:
            tokens_saved.append(e["tokens_before"] - e["tokens_after"])

    meetings_with_compaction = sum(1 for c in compaction_counts if c > 0)
    print(f"  Meetings with compaction: {meetings_with_compaction}/{n} ({meetings_with_compaction/n*100:.0f}%)")
    print(f"  Compaction events/meeting: {fmt_stats([float(x) for x in compaction_counts])}")
    if tokens_saved:
        print(f"  Tokens saved per compaction: {fmt_stats([float(x) for x in tokens_saved])}")

    # ------------------------------------------------------------------
    # 8. Per-agent role analysis
    # ------------------------------------------------------------------
    subsection("8. Agent Behavior Patterns")
    # Who proposes most? Who just agrees?
    proposer_ratio = []  # fraction of agents who made a proposal
    passive_ratio = []   # fraction of agents who only did satisfied (no proposal)

    for m in meetings:
        ac = m["results"].get("discussion_dynamics", {}).get("activity", {}).get("action_counts", {})
        if not ac:
            continue
        n_agents = len(ac)
        proposers = sum(1 for a in ac.values() if a.get("proposal", 0) > 0)
        passive = sum(1 for a in ac.values()
                       if a.get("satisfied", 0) > 0 and a.get("proposal", 0) == 0)
        proposer_ratio.append(proposers / n_agents * 100)
        passive_ratio.append(passive / n_agents * 100)

    print(f"  Agents who proposed (%): {fmt_stats(proposer_ratio, '%')}")
    print(f"  Agents who only agreed (%): {fmt_stats(passive_ratio, '%')}")

    # ------------------------------------------------------------------
    # 9. Prompt token growth over turns
    # ------------------------------------------------------------------
    subsection("9. Context Growth (prompt tokens over turns)")
    # Aggregate prompt tokens by turn number across all meetings
    turn_tokens = defaultdict(list)
    for m in meetings:
        calls = m["results"].get("discussion_dynamics", {}).get("activity", {}).get("llm_calls", [])
        for c in calls:
            turn_tokens[c.get("turn", 0)].append(c.get("prompt_tokens", 0))

    if turn_tokens:
        sorted_turns = sorted(turn_tokens.keys())
        # Show first, middle, last few turns
        show_turns = sorted_turns[:3] + sorted_turns[len(sorted_turns)//2:len(sorted_turns)//2+1] + sorted_turns[-3:]
        show_turns = sorted(set(show_turns))
        for t in show_turns:
            vals = turn_tokens[t]
            print(f"  Turn {t:3d}: mean={statistics.mean(vals):,.0f} tokens ({len(vals)} calls)")

    # ------------------------------------------------------------------
    # 10. Correlation: duration vs turns/tokens
    # ------------------------------------------------------------------
    subsection("10. Duration Correlations")
    dur_turn_pairs = []
    dur_token_pairs = []
    for m in meetings:
        r = m["results"]
        meta = r.get("metadata", {})
        st, et = meta.get("start_time"), meta.get("end_time")
        if not (st and et):
            continue
        dur = et - st
        calls = r.get("discussion_dynamics", {}).get("activity", {}).get("llm_calls", [])
        total_tok = sum(c.get("prompt_tokens", 0) + c.get("completion_tokens", 0) for c in calls)
        conv_len = len(r.get("conversation_history", []))
        dur_turn_pairs.append((dur, conv_len))
        dur_token_pairs.append((dur, total_tok))

    if len(dur_turn_pairs) >= 3:
        # Simple Pearson correlation
        def pearson(pairs):
            xs, ys = zip(*pairs)
            mx, my = statistics.mean(xs), statistics.mean(ys)
            num = sum((x - mx) * (y - my) for x, y in pairs)
            dx = sum((x - mx) ** 2 for x in xs) ** 0.5
            dy = sum((y - my) ** 2 for y in ys) ** 0.5
            return num / (dx * dy) if dx * dy else 0

        print(f"  Duration vs conversation length: r={pearson(dur_turn_pairs):.3f}")
        print(f"  Duration vs total tokens: r={pearson(dur_token_pairs):.3f}")


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <result_json> [result_json ...]")
        sys.exit(1)

    for path in sys.argv[1:]:
        analyze_file(path)

    print()


if __name__ == "__main__":
    main()

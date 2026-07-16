#!/usr/bin/env python3
"""System Validation (Exp 0) table aggregation.

Aggregates one row per (model, participant-count) cell from result files named
  data/result_vllm_{model}_meetings_p{P}_n50_sysval_mixed.json

Metrics:
  completion   strict completion rate: meeting ran to a terminal state
               (consensus or max_turns) AND contains zero participation-failure
               utterances ("[error] ..." entries in the conversation).
               NOTE: exit-0 / file-written alone is NOT completion — a run with
               every LLM call failing still "finishes" (see gpt-5.4-mini
               temperature incident).
  consensus    share of meetings terminating via consensus (secondary)
  retry>0      share of LLM calls that needed at least one retry
  retries/call mean retries per LLM call
  err utt      participation-failure utterances per meeting
  time corr    route time-corrections per meeting
  turns        participant utterances per meeting (mean)
  calls        LLM calls per meeting (mean)
  tokens       prompt+completion tokens per meeting (mean, k)
  sat          mean post-consensus satisfaction (sanity check)

Wall-clock/duration is intentionally omitted: cells replayed from the litellm
cache (e.g. Qwen3.5-9B P3 == turncmp rot0) have non-representative timings.

Run from the repository root:
  python3 evaluation/sysval_analysis.py
  python3 evaluation/sysval_analysis.py --models Qwen_Qwen3.5-9B --sizes 3 5 10
"""
import argparse
import glob
import json
import re
from collections import defaultdict

DEFAULT_MODELS = ["Qwen_Qwen3.5-2B", "Qwen_Qwen3.5-4B", "Qwen_Qwen3.5-9B",
                  "openai_gpt-oss-20b"]


def cell_metrics(path):
    d = json.load(open(path))
    ms = d["meetings"]
    n = len(ms)
    stats = defaultdict(float)
    stats["n"] = n
    sat_all = []
    for m in ms:
        r = m.get("results")
        if not r:
            continue
        stats["ran"] += 1
        term = r["metadata"].get("termination_reason")
        if term == "consensus":
            stats["consensus"] += 1
        n_err = sum(1 for e in r["conversation_history"]
                    if e["name"] != "System" and e["content"].startswith("[error]"))
        stats["err_utt"] += n_err
        if term in ("consensus", "max_turns") and n_err == 0:
            stats["completed"] += 1
        calls = r["discussion_dynamics"]["activity"].get("llm_calls") or []
        stats["calls"] += len(calls)
        stats["retried_calls"] += sum(1 for c in calls if (c.get("retries") or 0) > 0)
        stats["retries"] += sum(c.get("retries") or 0 for c in calls)
        stats["tokens"] += sum((c.get("prompt_tokens") or 0) + (c.get("completion_tokens") or 0)
                               for c in calls)
        stats["time_corr"] += len(r["route_characteristics"].get("time_corrections") or [])
        stats["turns"] += sum(1 for e in r["conversation_history"] if e["name"] != "System")
        for ev in r.get("post_consensus_evaluations") or []:
            if ev.get("score") is not None:
                sat_all.append(ev["score"])
    stats["sat"] = sum(sat_all) / len(sat_all) if sat_all else float("nan")
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--models", nargs="*", default=DEFAULT_MODELS)
    ap.add_argument("--sizes", nargs="*", type=int, default=[3, 5, 10])
    ap.add_argument("--suffix", default="sysval_mixed")
    args = ap.parse_args()

    header = (f"{'model':<22s} {'P':>3s} {'compl':>6s} {'cons':>6s} {'retry>0':>8s} "
              f"{'ret/call':>8s} {'errU/m':>7s} {'tcorr/m':>8s} {'turns':>6s} "
              f"{'calls':>6s} {'tok(k)':>7s} {'sat':>5s}")
    print(header)
    print("-" * len(header))
    for model in args.models:
        for p in args.sizes:
            path = f"{args.data_dir}/result_vllm_{model}_meetings_p{p}_n50_{args.suffix}.json"
            if not glob.glob(path):
                print(f"{model:<22s} {p:>3d}   (missing: {path})")
                continue
            s = cell_metrics(path)
            ran = s["ran"] or 1
            calls = s["calls"] or 1
            print(f"{model:<22s} {p:>3d} "
                  f"{s['completed']/s['n']:>6.2f} {s['consensus']/s['n']:>6.2f} "
                  f"{s['retried_calls']/calls:>8.3f} {s['retries']/calls:>8.3f} "
                  f"{s['err_utt']/ran:>7.2f} {s['time_corr']/ran:>8.2f} "
                  f"{s['turns']/ran:>6.1f} {s['calls']/ran:>6.1f} "
                  f"{s['tokens']/ran/1000:>7.0f} {s['sat']:>5.2f}")


if __name__ == "__main__":
    main()

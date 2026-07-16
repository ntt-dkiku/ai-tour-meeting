#!/usr/bin/env python3
"""Export an experiment meeting (scenario + result) into the GUI store
(tour_meeting/data/meetings.json) so it can be browsed in the frontend.

Usage:
  python3 evaluation/export_case_study.py \
      --scenario data/meetings_p3_n50_mixed_gpt-5.4-mini.json --index 3 \
      --result data/result_vllm_Qwen_Qwen3.5-9B_meetings_p3_n50_mixed_gpt-5.4-mini.json \
      --title "Case Study: Seoul (Performative Capitulation / inviting)" \
      --turn-rule inviting --vote-turn-rule inviting

Note: the backend loads the store at startup and rewrites it from memory on
save — restart the backend AFTER running this, and only when no experiment
is running inside the backend container (make run execs there).
"""
import argparse
import datetime
import json
import uuid

STORE = "tour_meeting/data/meetings.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", required=True)
    ap.add_argument("--result", required=True)
    ap.add_argument("--index", type=int, required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--model", default="vllm/Qwen/Qwen3.5-9B")
    ap.add_argument("--temperature", type=float, default=0.6)
    ap.add_argument("--turn-rule", default="inviting")
    ap.add_argument("--vote-turn-rule", default="inviting")
    ap.add_argument("--voting-rule", default="majority")
    args = ap.parse_args()

    with open(args.scenario, encoding="utf-8") as f:
        scen = json.load(f)["meetings"][args.index]
    with open(args.result, encoding="utf-8") as f:
        resm = json.load(f)["meetings"][args.index]
    assert scen["title"] == resm["title"], (scen["title"], resm["title"])
    res = resm["results"]

    participants, order = [], []
    for p in scen["participants"]:
        pid = uuid.uuid4().hex[:12]
        order.append(pid)
        participants.append({
            "id": pid, "engine_name": p["name"], "avatar": None,
            "model_name": args.model, "temperature": args.temperature,
            "seed": 42, "max_tokens": 8192, "max_context_length": 32768,
            "context_mode": "auto_compact", "auto_compact_threshold": 0.8,
            "auto_compact_target": 0.5, "compact_recent_ratio": 0.7,
            "fixed_turns_count": 10,
            "name": p["name"], "background": p["background"],
            "personality": p["personality"], "preferences": p["preferences"],
            "personal_goals": p["personal_goals"],
            "role": p.get("role", "attendee"),
            "speaking_style": p.get("speaking_style", "friendly"),
            "explanation_style": p.get("explanation_style", "auto"),
            "web_search": False, "max_steps": 10,
            "system_prompt": None, "incomplete": False,
        })

    ph = res["discussion_dynamics"]["proposals"]["proposals_history"]
    conv = res["conversation_history"]
    history = [{"type": "human", "name": "MeetingGoal", "content": scen["global_goals"]}]
    prop_i = 0
    for i, e in enumerate(conv):
        entry = {"type": "ai", "name": e["name"], "content": e["content"]}
        nxt = conv[i + 1] if i + 1 < len(conv) else None
        if nxt and nxt["name"] == "System" and "Proposal Voting" in nxt["content"] and prop_i < len(ph):
            entry["route_plan"] = ph[prop_i]["proposal"]
            entry["turn"] = ph[prop_i]["turn"]
            prop_i += 1
        history.append(entry)
    accepted = [s for s in res["route_characteristics"]["route_snapshots"] if s["phase"] == "accepted"]
    if accepted:
        history.append({
            "type": "ai", "name": "System", "content": "Final route visualization",
            "route_plan": {"route": [d["name"] for d in accepted[-1]["destinations"]],
                            "destinations": accepted[-1]["destinations"]},
        })
    print(f"proposals matched: {prop_i}/{len(ph)}; history entries: {len(history)}")

    rec = {
        "title": args.title,
        "created_at": datetime.datetime.now().isoformat(),
        "include_human": False, "human_name": "You", "human_avatar": None,
        "human_role": "attendee",
        "order": order, "participants": participants, "history": history,
        "global_goal": scen["global_goals"],
        "max_turns": 100, "time_limit": None,
        "travel_date": "2026-03-15",
        "time_window_start": "09:00", "time_window_end": "18:00",
        "budget": "$100",
        "initialization_turn_rule": args.turn_rule,
        "initialization_voting_rule": args.voting_rule,
        "volunteer_mode": False, "balanced_turns": True,
        "vote_settings_linked": True, "vote_turn_rule": args.vote_turn_rule,
        "single_decider": None,
        "status": "finished", "status_detail": None,
        "elapsed_seconds": res["metadata"].get("duration", 0),
        "analytics_data": {
            "discussion_dynamics": res["discussion_dynamics"],
            "route_characteristics": res["route_characteristics"],
            "satisfied_progression": res["satisfied_progression"],
            "post_consensus_evaluations": res["post_consensus_evaluations"],
            "deadlock_interventions": res.get("deadlock_interventions", []),
            "metadata": res["metadata"],
        },
    }

    with open(STORE, encoding="utf-8") as f:
        store = json.load(f)
    mid = str(uuid.uuid4())
    store["meetings"][mid] = rec
    with open(STORE, "w", encoding="utf-8") as f:
        json.dump(store, f, indent=2, ensure_ascii=False)
    print(f"saved '{args.title}' as {mid}")


if __name__ == "__main__":
    main()

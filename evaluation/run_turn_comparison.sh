#!/usr/bin/env bash
# Turn-order comparison: does speaking position create a structural advantage?
#
# Takes one scenario set and creates 3 cyclic rotations of the participant
# list (a Latin square over speaking positions: every participant occupies
# every position exactly once across conditions), then runs all rotations
# under round_robin via the shared dynamic GPU queue (run_diversity_exp.sh).
#
# Conditions: rot0 (original order), rot1, rot2 — paired by scenario.
# The inviting counterpart for the same scenarios already exists as the
# Exp 1 result (it ran with turn_rule=inviting on the original order).
#
# Usage:
#   bash evaluation/run_turn_comparison.sh
#   PREP_ONLY=1 bash evaluation/run_turn_comparison.sh   # build variant files only
#   NUM_GPUS=4 INPUT=data/meetings_p3_n50_mixed_gpt-5.4-mini.json \
#     bash evaluation/run_turn_comparison.sh
set -euo pipefail

cd "$(dirname "$0")/.."

INPUT="${INPUT:-data/meetings_p3_n50_conflicting_gpt-5.4-mini.json}"
SIZE="${SIZE:-p3_n50}"
SUFFIX="${SUFFIX:-turncmp}"
TURN_RULE="${TURN_RULE:-round_robin}"
VOTE_TURN_RULE="${VOTE_TURN_RULE:-round_robin}"
CHUNK_DIR="${CHUNK_DIR:-data/chunks_turn_comparison}"
PREP_ONLY="${PREP_ONLY:-0}"

# ── Preprocess: cyclic rotations of the participant order ──────────────
python3 - "$INPUT" "$SIZE" "$SUFFIX" <<'PYEOF'
import json, sys
src, size, suffix = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src, encoding="utf-8") as f:
    meetings = json.load(f)["meetings"]
n_participants = {len(m["participants"]) for m in meetings}
assert len(n_participants) == 1, f"mixed participant counts: {n_participants}"
k = n_participants.pop()
for r in range(k):
    rotated = []
    for m in meetings:
        m2 = dict(m)
        ps = m["participants"]
        m2["participants"] = ps[r:] + ps[:r]
        rotated.append(m2)
    out = f"data/meetings_{size}_rot{r}_{suffix}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"meetings": rotated}, f, indent=2, ensure_ascii=False)
    first = ", ".join(m["participants"][0]["name"] for m in rotated[:3])
    print(f"[prep] {out}: rotation={r} (first speakers e.g. {first} ...)")
PYEOF

if [ "$PREP_ONLY" = "1" ]; then
    echo "=== PREP_ONLY: variant files written, not running ==="
    exit 0
fi

# ── Run all rotations via the shared dynamic GPU queue ─────────────────
CHUNK_DIR="$CHUNK_DIR" \
ALIGNMENTS="rot0 rot1 rot2" \
SIZE="$SIZE" SUFFIX="$SUFFIX" \
EXTRA_ARGS="--turn-rule ${TURN_RULE} --vote-turn-rule ${VOTE_TURN_RULE}" \
bash evaluation/run_diversity_exp.sh

echo "=== Turn comparison complete ==="

#!/usr/bin/env bash
# Diversity experiment: run the N=50 alignment scenarios (aligned / mixed /
# conflicting) across multiple vLLM GPU instances in parallel.
#
# Scenarios are split into small chunks that go into a shared work queue;
# one worker per GPU keeps pulling the next chunk until the queue is empty,
# so GPUs freed by fast conditions (aligned) automatically pick up remaining
# work from slow ones (conflicting). Chunk results are merged back into one
# result file per alignment (same shape as a direct run).
#
# Usage:
#   bash evaluation/run_diversity_exp.sh              # 8 GPUs (0-7)
#   NUM_GPUS=4 bash evaluation/run_diversity_exp.sh   # GPUs 0-3
#   GPUS="1 2 3 4 5 6 7" bash evaluation/run_diversity_exp.sh   # skip GPU 0
#   NUM_GPUS=8 MODEL=Qwen/Qwen3.5-9B NUM_PARALLEL=5 TEMPERATURE=0.6 \
#     bash evaluation/run_diversity_exp.sh
#
# Join a RUNNING experiment with an extra GPU worker (e.g. after the GPU
# frees up) — it pulls chunks from the same queue until it is empty:
#   bash evaluation/run_diversity_exp.sh --worker 0
#
# Prerequisite: the stack is up with vLLM instances on the GPUs used, e.g.
#   make up VLLM="Qwen/Qwen3.5-9B:gpu=0 Qwen/Qwen3.5-9B:gpu=1 ... :gpu=7"
set -euo pipefail

cd "$(dirname "$0")/.."

NUM_GPUS="${NUM_GPUS:-8}"
# Explicit GPU list overrides NUM_GPUS (e.g. GPUS="1 2 3" to skip GPU 0).
GPUS="${GPUS:-$(seq -s' ' 0 $((NUM_GPUS - 1)))}"
MODEL="${MODEL:-Qwen/Qwen3.5-9B}"
CHUNK_SIZE="${CHUNK_SIZE:-5}"           # meetings per work unit
NUM_PARALLEL="${NUM_PARALLEL:-5}"       # meetings in flight per chunk
TEMPERATURE="${TEMPERATURE:-0.6}"
ALIGNMENTS="${ALIGNMENTS:-aligned mixed conflicting}"
SUFFIX="${SUFFIX:-gpt-5.4-mini}"        # scenario filename suffix
SIZE="${SIZE:-p3_n50}"                  # scenario size tag
EXTRA_ARGS="${EXTRA_ARGS:-}"            # extra run_paper_experiment.py flags (e.g. --turn-rule round_robin)
DATA_DIR="data"
CHUNK_DIR="${CHUNK_DIR:-${DATA_DIR}/chunks_diversity_exp}"
QUEUE_FILE="${CHUNK_DIR}/queue.txt"
LOCK_FILE="${CHUNK_DIR}/queue.lock"

mkdir -p "$CHUNK_DIR"

# ── Worker machinery (also used by --worker join mode) ─────────────────
pop_chunk() {
    # Atomically pop the first line of the queue (flock-serialized).
    flock "$LOCK_FILE" bash -c "
        line=\$(head -n1 '$QUEUE_FILE' 2>/dev/null)
        if [ -n \"\$line\" ]; then
            tail -n +2 '$QUEUE_FILE' > '$QUEUE_FILE.tmp' && mv '$QUEUE_FILE.tmp' '$QUEUE_FILE'
            printf '%s\n' \"\$line\"
        fi
    "
}

worker() {
    local gpu="$1"
    while true; do
        local line
        line=$(pop_chunk)
        [ -z "$line" ] && break
        local align chunk result
        IFS=$'\t' read -r align chunk result <<< "$line"
        local tag
        tag=$(basename "$chunk" .json)
        local marker="${CHUNK_DIR}/active_gpu${gpu}_${tag}"
        touch "$marker"
        echo "[gpu${gpu}] start ${tag}"
        if make run SCRIPT=examples/run_paper_experiment.py ARGS="--input ${chunk} \
            --model vllm/${gpu}/${MODEL} --temperature ${TEMPERATURE} \
            --num-parallel ${NUM_PARALLEL} --output ${result} ${EXTRA_ARGS}" \
            > "${CHUNK_DIR}/log_gpu${gpu}_${tag}.log" 2>&1; then
            echo "[gpu${gpu}] done  ${tag}"
        else
            echo "[gpu${gpu}] FAILED ${tag} (see log_gpu${gpu}_${tag}.log)" >&2
            echo "${align}	${chunk}	${result}" >> "${CHUNK_DIR}/failed.txt"
        fi
        rm -f "$marker"
    done
}

# ── Join mode: attach one extra worker to a running experiment ─────────
if [ "${1:-}" = "--worker" ]; then
    gpu_id="${2:?Usage: run_diversity_exp.sh --worker <gpu>}"
    if [ ! -f "$QUEUE_FILE" ]; then
        echo "No queue at ${QUEUE_FILE} — is the experiment running?" >&2
        exit 1
    fi
    echo "=== Joining running experiment as gpu${gpu_id} worker ==="
    worker "$gpu_id"
    echo "=== gpu${gpu_id} worker finished (queue empty) ==="
    exit 0
fi

# ── 1) Split every alignment's scenarios into CHUNK_SIZE-sized chunks ──
# Slow conditions first so their chunks start as early as possible.
python3 - "$SIZE" "$SUFFIX" "$CHUNK_DIR" "$CHUNK_SIZE" $ALIGNMENTS <<'PYEOF' > "$QUEUE_FILE"
import json, sys
size, suffix, chunk_dir, chunk_size = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
aligns = sys.argv[5:]
# Longest-expected-first ordering keeps slow chunks from being scheduled last.
priority = {"conflicting": 0, "mixed": 1, "aligned": 2}
for a in sorted(aligns, key=lambda x: priority.get(x, 9)):
    src = f"data/meetings_{size}_{a}_{suffix}.json"
    with open(src, encoding="utf-8") as f:
        meetings = json.load(f)["meetings"]
    for ci, start in enumerate(range(0, len(meetings), chunk_size)):
        chunk = meetings[start:start + chunk_size]
        chunk_path = f"{chunk_dir}/{a}_chunk{ci:02d}.json"
        with open(chunk_path, "w", encoding="utf-8") as f:
            json.dump({"meetings": chunk}, f, indent=2, ensure_ascii=False)
        print(f"{a}\t{chunk_path}\t{chunk_dir}/result_{a}_chunk{ci:02d}.json")
PYEOF

total_chunks=$(wc -l < "$QUEUE_FILE")
echo "=== ${total_chunks} chunks queued (chunk size ${CHUNK_SIZE}, workers on GPUs: ${GPUS}) ==="

# ── 2) One worker per GPU pulls chunks from the queue until it is empty ──
touch "$LOCK_FILE"
rm -f "${CHUNK_DIR}/failed.txt"
rm -f "${CHUNK_DIR}"/active_gpu*
pids=()
for gpu in $GPUS; do
    worker "$gpu" &
    pids+=($!)
done
for pid in "${pids[@]}"; do
    wait "$pid"
done

# Late-joined workers (--worker mode) may still be processing chunks after
# this script's own workers drain the queue — wait for their markers too.
while ls "${CHUNK_DIR}"/active_gpu* >/dev/null 2>&1; do
    echo "[wait] external workers still running: $(ls "${CHUNK_DIR}"/active_gpu* | xargs -n1 basename | tr '\n' ' ')"
    sleep 20
done

if [ -s "${CHUNK_DIR}/failed.txt" ]; then
    echo "Some chunks failed (listed in ${CHUNK_DIR}/failed.txt); skipping merge." >&2
    exit 1
fi

# ── 3) Merge chunk results back into one result file per alignment ─────
python3 - "$SIZE" "$SUFFIX" "$CHUNK_DIR" "$MODEL" $ALIGNMENTS <<'PYEOF'
import glob, json, re, sys
size, suffix, chunk_dir, model = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
aligns = sys.argv[5:]
safe_model = ("vllm/" + model).replace("/", "_")
for a in aligns:
    paths = sorted(
        glob.glob(f"{chunk_dir}/result_{a}_chunk*.json"),
        key=lambda p: int(re.search(r"chunk(\d+)", p).group(1)),
    )
    meetings = []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            meetings.extend(json.load(f)["meetings"])
    out = f"data/result_{safe_model}_meetings_{size}_{a}_{suffix}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"meetings": meetings}, f, indent=2, ensure_ascii=False)
    done = sum(1 for m in meetings if "results" in m)
    print(f"[merged] {out}: {done}/{len(meetings)} meetings with results")
PYEOF

echo "=== Diversity experiment complete ==="

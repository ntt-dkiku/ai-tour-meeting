#!/usr/bin/env bash
# Wait for vLLM instances to become ready and update .llm-mode with max_model_len.
# Called by `make up` after docker compose up (runs in background).
#
# Usage: update-llm-mode.sh <llm-mode-path> <host-port-start>
#
# Reads the existing .llm-mode, polls each vLLM instance's /v1/models endpoint,
# and rewrites .llm-mode with max_model_len added to each vLLM entry.

set -euo pipefail

LLM_MODE_PATH="${1:-.llm-mode}"
HOST_PORT_START="${2:-8001}"

if [ ! -f "$LLM_MODE_PATH" ]; then
  exit 0
fi

# Check if python3 is available
if ! command -v python3 &>/dev/null; then
  echo "[update-llm-mode] python3 not found, skipping" >&2
  exit 0
fi

# Count vLLM instances from .llm-mode
VLLM_COUNT=$(python3 -c "
import json, sys
data = json.loads(open('$LLM_MODE_PATH').read())
print(len(data.get('vllm', [])))
" 2>/dev/null || echo "0")

if [ "$VLLM_COUNT" = "0" ]; then
  exit 0
fi

MAX_WAIT=120  # seconds to wait for each instance
POLL_INTERVAL=3

# Poll silently; only warnings go to stderr.

for (( idx=0; idx<VLLM_COUNT; idx++ )); do
  PORT=$((HOST_PORT_START + idx))
  URL="http://localhost:${PORT}/v1/models"
  WAITED=0

  while [ "$WAITED" -lt "$MAX_WAIT" ]; do
    RESPONSE=$(curl -s --max-time 5 "$URL" 2>/dev/null || true)
    if [ -n "$RESPONSE" ]; then
      MAX_LEN=$(echo "$RESPONSE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
models = data.get('data', [])
if models:
    print(models[0].get('max_model_len', ''))
" 2>/dev/null || true)
      if [ -n "$MAX_LEN" ]; then
        # vLLM-${idx} ready
        # Update .llm-mode
        python3 -c "
import json, sys
path = '$LLM_MODE_PATH'
data = json.loads(open(path).read())
vllm = data.get('vllm', [])
if $idx < len(vllm):
    vllm[$idx]['max_model_len'] = $MAX_LEN
    open(path, 'w').write(json.dumps(data) + '\n')
" 2>/dev/null
        break
      fi
    fi
    sleep "$POLL_INTERVAL"
    WAITED=$((WAITED + POLL_INTERVAL))
  done

  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo "[update-llm-mode] WARNING: vLLM-${idx} did not respond within ${MAX_WAIT}s" >&2
  fi
done


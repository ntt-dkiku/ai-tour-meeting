#!/usr/bin/env bash
# Generate docker-compose YAML for multi-instance vLLM deployment.
#
# Usage:
#   gen-vllm-compose.sh "VLLM_SPEC" [VLLM_JSON_OUT] [HOST_PORT_START]
#
# VLLM_SPEC format (space-separated entries):
#   model_name                    → single GPU 0, TP=1
#   model_name:gpu=0,1            → tensor parallel on GPU 0,1, TP=2
#   model1:gpu=0 model2:gpu=1     → two separate instances
#
# Outputs docker-compose YAML to stdout.
# Optionally writes the vllm JSON array (for .llm-mode) to VLLM_JSON_OUT.

set -euo pipefail

VLLM_SPEC="${1:-}"
VLLM_JSON_OUT="${2:-}"
HOST_PORT_START="${3:-8001}"

if [ -z "$VLLM_SPEC" ]; then
  echo "Error: No VLLM spec provided" >&2
  exit 1
fi

IFS=' ' read -ra ENTRIES <<< "$VLLM_SPEC"

# --- YAML header ---
cat <<'HEADER'
services:
HEADER

INDEX=0
HOST_PORT=$HOST_PORT_START
BACKEND_ENV=""
JSON_ARRAY="["

for entry in "${ENTRIES[@]}"; do
  # Parse model:gpu=X,Y or just model
  if [[ "$entry" == *":gpu="* ]]; then
    MODEL="${entry%%:gpu=*}"
    GPU_SPEC="${entry##*:gpu=}"
  else
    MODEL="$entry"
    GPU_SPEC="0"
  fi

  # Split GPU IDs and count for tensor-parallel-size
  IFS=',' read -ra GPU_IDS <<< "$GPU_SPEC"
  TP_SIZE=${#GPU_IDS[@]}

  # Build YAML device_ids list: ['0', '1']
  DEVICE_IDS=""
  for gid in "${GPU_IDS[@]}"; do
    [ -n "$DEVICE_IDS" ] && DEVICE_IDS="${DEVICE_IDS}, "
    DEVICE_IDS="${DEVICE_IDS}'${gid}'"
  done

  SERVICE="vllm-${INDEX}"

  cat <<EOF
  ${SERVICE}:
    image: vllm/vllm-openai:latest
    container_name: tour-meeting-vllm-${INDEX}
    runtime: nvidia
    ports:
      - "${HOST_PORT}:8000"
    volumes:
      - ~/.cache/huggingface:/root/.cache/huggingface
    env_file:
      - path: .env
        required: false
    ipc: host
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: [${DEVICE_IDS}]
              capabilities: [gpu]
    command: --model ${MODEL} --tensor-parallel-size ${TP_SIZE}

EOF

  # Accumulate backend env lines
  BACKEND_ENV="${BACKEND_ENV}      - VLLM_BASE_${INDEX}=http://${SERVICE}:8000/v1\n"

  # Build JSON array element: {"model":"...","gpus":[0,1]}
  JSON_GPUS="["
  for i in "${!GPU_IDS[@]}"; do
    [ "$i" -gt 0 ] && JSON_GPUS="${JSON_GPUS},"
    JSON_GPUS="${JSON_GPUS}${GPU_IDS[$i]}"
  done
  JSON_GPUS="${JSON_GPUS}]"

  [ "$INDEX" -gt 0 ] && JSON_ARRAY="${JSON_ARRAY},"
  JSON_ARRAY="${JSON_ARRAY}{\"model\":\"${MODEL}\",\"gpus\":${JSON_GPUS}}"

  INDEX=$((INDEX + 1))
  HOST_PORT=$((HOST_PORT + 1))
done

JSON_ARRAY="${JSON_ARRAY}]"

# Backend service environment (VLLM_BASE as alias for VLLM_BASE_0)
printf "  backend:\n    environment:\n"
printf "%b" "$BACKEND_ENV"
printf "      - VLLM_BASE=\${VLLM_BASE_0:-http://vllm-0:8000/v1}\n"

# Write JSON fragment for .llm-mode if requested
if [ -n "$VLLM_JSON_OUT" ]; then
  printf '%s' "$JSON_ARRAY" > "$VLLM_JSON_OUT"
fi

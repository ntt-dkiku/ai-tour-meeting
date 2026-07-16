#!/usr/bin/env bash
# Generate docker-compose YAML for multi-instance Ollama deployment.
#
# Usage:
#   gen-ollama-compose.sh "OLLAMA_SPEC" [OLLAMA_JSON_OUT]
#
# OLLAMA_SPEC format:
#   cpu                           → single instance, no GPU
#   gpu                           → single instance, all GPUs
#   gpu:0,1                       → single instance, specific GPUs
#   gpu:0 gpu:1                   → two instances on separate GPUs
#   gpu:0,1 gpu:2,3               → two instances, each with 2 GPUs
#
# Outputs docker-compose YAML to stdout.
# Optionally writes the ollama JSON array (for .llm-mode) to OLLAMA_JSON_OUT.

set -euo pipefail

OLLAMA_SPEC="${1:-}"
OLLAMA_JSON_OUT="${2:-}"

if [ -z "$OLLAMA_SPEC" ]; then
  echo "Error: No OLLAMA spec provided" >&2
  exit 1
fi

# --- YAML header ---
cat <<'HEADER'
services:
HEADER

# Determine entries: "cpu" and "gpu" are single-entry shortcuts
if [ "$OLLAMA_SPEC" = "cpu" ] || [ "$OLLAMA_SPEC" = "gpu" ]; then
  ENTRIES=("$OLLAMA_SPEC")
else
  IFS=' ' read -ra ENTRIES <<< "$OLLAMA_SPEC"
fi

INDEX=0
HOST_PORT=11434
BACKEND_ENV=""
JSON_ARRAY="["

for entry in "${ENTRIES[@]}"; do
  SERVICE="ollama-${INDEX}"

  # Determine mode and GPU spec
  if [ "$entry" = "cpu" ]; then
    MODE="cpu"
    GPU_SPEC=""
  elif [ "$entry" = "gpu" ]; then
    MODE="gpu"
    GPU_SPEC="all"
  elif [[ "$entry" == gpu:* ]]; then
    MODE="gpu"
    GPU_SPEC="${entry#gpu:}"
  else
    echo "Error: Invalid entry '$entry'. Expected cpu, gpu, or gpu:X,Y" >&2
    exit 1
  fi

  # --- Service YAML ---
  cat <<EOF
  ${SERVICE}:
    image: ollama/ollama:latest
    container_name: tour-meeting-ollama-${INDEX}
    ports:
      - "${HOST_PORT}:11434"
    volumes:
      - \${HOME}/.ollama:/root/.ollama
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "bash", "-lc", "curl -sf http://localhost:11434/api/tags >/dev/null || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 15
EOF

  # Add GPU configuration
  if [ "$MODE" = "gpu" ]; then
    if [ "$GPU_SPEC" = "all" ]; then
      cat <<EOF
    runtime: nvidia
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
EOF
    else
      # Specific GPU IDs
      IFS=',' read -ra GPU_IDS <<< "$GPU_SPEC"
      DEVICE_IDS=""
      for gid in "${GPU_IDS[@]}"; do
        [ -n "$DEVICE_IDS" ] && DEVICE_IDS="${DEVICE_IDS}, "
        DEVICE_IDS="${DEVICE_IDS}'${gid}'"
      done
      cat <<EOF
    runtime: nvidia
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: [${DEVICE_IDS}]
              capabilities: [gpu]
EOF
    fi
  fi

  # Blank line between services
  echo ""

  # Accumulate backend env lines
  BACKEND_ENV="${BACKEND_ENV}      - OLLAMA_BASE_${INDEX}=http://${SERVICE}:11434\n"

  # Build JSON array element: {"mode":"gpu","gpus":[0,1]}
  JSON_GPUS="["
  if [ "$MODE" = "gpu" ] && [ "$GPU_SPEC" != "all" ] && [ -n "$GPU_SPEC" ]; then
    IFS=',' read -ra GPU_IDS <<< "$GPU_SPEC"
    for i in "${!GPU_IDS[@]}"; do
      [ "$i" -gt 0 ] && JSON_GPUS="${JSON_GPUS},"
      JSON_GPUS="${JSON_GPUS}${GPU_IDS[$i]}"
    done
  fi
  JSON_GPUS="${JSON_GPUS}]"

  [ "$INDEX" -gt 0 ] && JSON_ARRAY="${JSON_ARRAY},"
  JSON_ARRAY="${JSON_ARRAY}{\"mode\":\"${MODE}\",\"gpus\":${JSON_GPUS}}"

  INDEX=$((INDEX + 1))
  HOST_PORT=$((HOST_PORT + 1))
done

JSON_ARRAY="${JSON_ARRAY}]"

# Backend service environment (OLLAMA_BASE as alias for OLLAMA_BASE_0)
printf "  backend:\n    environment:\n"
printf "%b" "$BACKEND_ENV"
printf "      - OLLAMA_BASE=\${OLLAMA_BASE_0:-http://ollama-0:11434}\n"

# Write JSON fragment for .llm-mode if requested
if [ -n "$OLLAMA_JSON_OUT" ]; then
  printf '%s' "$JSON_ARRAY" > "$OLLAMA_JSON_OUT"
fi

#!/usr/bin/env bash
# Generate meeting scenarios for the evaluation experiments via make gen-meetings.
#
# Requires the stack to be running (make up) since generation happens
# inside the backend container.
#
# Usage:
#   bash evaluation/gen_meetings.sh
#   NUM_MEETINGS=20 NUM_PARTICIPANTS=5 bash evaluation/gen_meetings.sh
#   INSTRUCTION="Barcelona tours" OUTPUT=data/barcelona_p3_n50.json bash evaluation/gen_meetings.sh
set -euo pipefail

cd "$(dirname "$0")/.."

DEFAULT_INSTRUCTION="Create diverse tour meetings in various cities around the world. \
Keep the global goal NEUTRAL: it must state only the shared frame (agreeing on a single one-day itinerary in the city) \
plus generic logistics (reasonable pace, time/budget limits). Do NOT enumerate interests, activity types, or themes \
in the global goal — those belong to individual participants. \
Keep the meeting title neutral as well: it should just indicate the city and the one-day tour, \
without hinting at harmony or conflict among participants (no words like 'Debate', 'Standoff', 'vs.')."
INSTRUCTION="${INSTRUCTION:-${DEFAULT_INSTRUCTION}}"
GEN_MODEL="${GEN_MODEL:-openai/gpt-5.4-mini}"
NUM_MEETINGS="${NUM_MEETINGS:-50}"
NUM_PARTICIPANTS="${NUM_PARTICIPANTS:-3}"
SEED="${SEED:-42}"
ALIGNMENT="${ALIGNMENT:-mixed}"
OUTPUT="${OUTPUT:-data/meetings_p${NUM_PARTICIPANTS}_n${NUM_MEETINGS}_${ALIGNMENT}_gpt-5.4-mini.json}"

echo "=== Generating ${NUM_MEETINGS} meetings (P${NUM_PARTICIPANTS}, ${ALIGNMENT}) with ${GEN_MODEL} -> ${OUTPUT} ==="

make gen-meetings \
    INSTRUCTION="${INSTRUCTION}" \
    GEN_MODEL="${GEN_MODEL}" \
    NUM_MEETINGS="${NUM_MEETINGS}" \
    NUM_PARTICIPANTS="${NUM_PARTICIPANTS}" \
    SEED="${SEED}" \
    ALIGNMENT="${ALIGNMENT}" \
    OUTPUT="${OUTPUT}"

echo "=== Done: ${OUTPUT} ==="

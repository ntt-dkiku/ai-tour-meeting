# AI Tour Meeting Makefile
# Docker Compose wrapper for Linux and Mac

.PHONY: up down build logs open clean help test test-frontend test-frontend-watch test-frontend-coverage test-backend test-backend-watch run gen-meetings

# OS detection
UNAME := $(shell uname)
ifeq ($(UNAME), Darwin)
	OPEN_CMD := open
else
	OPEN_CMD := $(shell command -v xdg-open 2>/dev/null || echo "echo 'xdg-open not found, please open manually:'")
endif

# Docker directory
DOCKER_DIR := docker

# Options
OLLAMA ?=
VLLM ?=
OPEN_GUI ?=
VLLM_HOST_PORT ?= 8001
DEBUG ?=

# Compose files — auto-include generated files if they exist on disk,
# so that `make down` / `make logs` work without re-specifying OLLAMA/VLLM.
COMPOSE_FILES = -f docker-compose.yaml \
  $(if $(wildcard $(DOCKER_DIR)/docker-compose.ollama.generated.yaml),-f docker-compose.ollama.generated.yaml) \
  $(if $(wildcard $(DOCKER_DIR)/docker-compose.vllm.generated.yaml),-f docker-compose.vllm.generated.yaml)

# Docker compose command (recursively expanded so wildcard is re-evaluated)
DOCKER_COMPOSE = cd $(DOCKER_DIR) && docker compose $(COMPOSE_FILES)

# Test compose command
TEST_COMPOSE := cd $(DOCKER_DIR) && docker compose -f docker-compose.test.yaml

# URL
GUI_URL := http://localhost:3000

# Default target
.DEFAULT_GOAL := help

## up: Start containers (with build)
up:
ifneq ($(OLLAMA),)
	@cd $(DOCKER_DIR) && bash gen-ollama-compose.sh "$(OLLAMA)" /tmp/.ollama-mode-fragment > docker-compose.ollama.generated.yaml
else
	@printf '[]' > /tmp/.ollama-mode-fragment
	@rm -f $(DOCKER_DIR)/docker-compose.ollama.generated.yaml
endif
ifneq ($(VLLM),)
	@cd $(DOCKER_DIR) && bash gen-vllm-compose.sh "$(VLLM)" /tmp/.vllm-mode-fragment $(VLLM_HOST_PORT) > docker-compose.vllm.generated.yaml
else
	@printf '[]' > /tmp/.vllm-mode-fragment
	@rm -f $(DOCKER_DIR)/docker-compose.vllm.generated.yaml
endif
	@printf '{"ollama":%s,"vllm":%s}\n' "$$(cat /tmp/.ollama-mode-fragment)" "$$(cat /tmp/.vllm-mode-fragment)" > .llm-mode
ifneq ($(DEBUG),)
	export DEBUG_PROMPTS=1 && $(DOCKER_COMPOSE) up --build -d --remove-orphans
else
	$(DOCKER_COMPOSE) up --build -d --remove-orphans
endif
ifneq ($(VLLM),)
	@bash $(DOCKER_DIR)/update-llm-mode.sh .llm-mode $(VLLM_HOST_PORT) &
endif
	@echo ""
	@echo "AI Tour Meeting is running!"
	@echo "Access the GUI at: $(GUI_URL)"
ifneq ($(OPEN_GUI),)
	@sleep 2
	@$(OPEN_CMD) $(GUI_URL)
endif

## down: Stop and remove containers
down:
	$(DOCKER_COMPOSE) down

## build: Build images only
build:
	$(DOCKER_COMPOSE) build

## logs: Show container logs (follow mode)
logs:
	$(DOCKER_COMPOSE) logs -f

## open: Open GUI in browser
open:
	@$(OPEN_CMD) $(GUI_URL)

## clean: Remove containers, volumes, images, and generated compose files
clean:
	$(DOCKER_COMPOSE) down -v --rmi local
	@rm -f $(DOCKER_DIR)/docker-compose.ollama.generated.yaml $(DOCKER_DIR)/docker-compose.vllm.generated.yaml .llm-mode

## test: Run all tests (frontend + backend)
test: test-frontend test-backend

## test-frontend: Run frontend tests in Docker
test-frontend:
	$(TEST_COMPOSE) build frontend-test
	$(TEST_COMPOSE) run --rm frontend-test

## test-frontend-watch: Run frontend tests in watch mode (for development)
test-frontend-watch:
	$(TEST_COMPOSE) build frontend-test-watch
	$(TEST_COMPOSE) run --rm frontend-test-watch

## test-frontend-coverage: Run frontend tests with coverage report
test-frontend-coverage:
	$(TEST_COMPOSE) build frontend-test-coverage
	$(TEST_COMPOSE) run --rm frontend-test-coverage

## test-backend: Run backend (Python) tests in Docker
test-backend:
	$(TEST_COMPOSE) build backend-test
	$(TEST_COMPOSE) run --rm backend-test

## test-backend-watch: Run backend tests with volume mount (for development)
test-backend-watch:
	$(TEST_COMPOSE) build backend-test-watch
	$(TEST_COMPOSE) run --rm backend-test-watch

## run: Run a Python example script inside the backend container
##   Usage: make run SCRIPT=examples/barcelona.py [ARGS="--max-turns 10"]
##   The script runs inside Docker where vLLM/Ollama env vars are available.
SCRIPT ?=
ARGS ?=
run:
ifndef SCRIPT
	@echo "Usage: make run SCRIPT=<path> [ARGS=\"...\"]"
	@echo ""
	@echo "Examples:"
	@echo "  make run SCRIPT=examples/barcelona.py"
	@echo "  make run SCRIPT=examples/barcelona.py ARGS=\"--max-turns 10\""
	@echo "  make run SCRIPT=examples/barcelona.py ARGS=\"--model openai/gpt-5-mini-2025-08-07\""
	@exit 1
else
	$(DOCKER_COMPOSE) exec -e PYTHONPATH=/app -e VLLM_BASE_0=http://vllm-0:8000/v1 -e VLLM_BASE_1=http://vllm-1:8000/v1 backend python3 $(SCRIPT) $(ARGS)
endif

## gen-meetings: Generate meeting scenario(s) via LLM
INSTRUCTION ?=
GEN_MODEL ?=
NUM_MEETINGS ?=
NUM_PARTICIPANTS ?=
OUTPUT ?=
TEMPERATURE ?=
SEED ?=
MAX_RETRIES ?=
MAX_TOTAL_ATTEMPTS ?=
ALIGNMENT ?=
gen-meetings:
ifndef INSTRUCTION
	@echo "Usage: make gen-meetings INSTRUCTION=\"...\" GEN_MODEL=<model> OUTPUT=<file.json> [options]"
	@echo ""
	@echo "Required:"
	@echo "  INSTRUCTION       Text instruction for scenario generation"
	@echo "  GEN_MODEL         LLM for generation (e.g. openai/gpt-4o-mini)"
	@echo "  OUTPUT            Save generated meeting(s) to JSON file"
	@echo ""
	@echo "Optional:"
	@echo "  NUM_MEETINGS      Number of meetings to generate (default: 1)"
	@echo "  NUM_PARTICIPANTS  Number of participants per meeting (default: 3)"
	@echo "  TEMPERATURE       Sampling temperature for generation LLM (default: 1.0)"
	@echo "  SEED              Random seed for generation LLM (default: None)"
	@echo "  MAX_RETRIES       Max retries per meeting generation (default: 5)"
	@echo "  MAX_TOTAL_ATTEMPTS Max total attempts across all meetings (default: num_meetings*3)"
	@echo "  ALIGNMENT         Participant preference relation: aligned | mixed (default) | conflicting"
	@echo ""
	@echo "Examples:"
	@echo "  make gen-meetings INSTRUCTION=\"3 people touring Kyoto\" GEN_MODEL=openai/gpt-4o-mini OUTPUT=configs.json"
	@echo "  make gen-meetings INSTRUCTION=\"Barcelona tour\" GEN_MODEL=openai/gpt-4o-mini OUTPUT=configs.json NUM_MEETINGS=5 NUM_PARTICIPANTS=4"
	@exit 1
else ifndef GEN_MODEL
	@echo "Error: GEN_MODEL is required. Example: make gen-meetings INSTRUCTION=\"...\" GEN_MODEL=openai/gpt-4o-mini OUTPUT=configs.json"
	@exit 1
else ifndef OUTPUT
	@echo "Error: OUTPUT is required. Example: make gen-meetings INSTRUCTION=\"...\" GEN_MODEL=openai/gpt-4o-mini OUTPUT=configs.json"
	@exit 1
else
	$(DOCKER_COMPOSE) exec -e PYTHONPATH=/app backend python3 -m tour_meeting.generate_meetings \
		"$(INSTRUCTION)" --gen-model "$(GEN_MODEL)" --output "$(OUTPUT)" \
		$(if $(NUM_MEETINGS),--num-meetings $(NUM_MEETINGS)) \
		$(if $(NUM_PARTICIPANTS),--num-participants $(NUM_PARTICIPANTS)) \
		$(if $(TEMPERATURE),--temperature $(TEMPERATURE)) \
		$(if $(SEED),--seed $(SEED)) \
		$(if $(MAX_RETRIES),--max-retries $(MAX_RETRIES)) \
		$(if $(MAX_TOTAL_ATTEMPTS),--max-total-attempts $(MAX_TOTAL_ATTEMPTS)) \
		$(if $(ALIGNMENT),--alignment $(ALIGNMENT))
endif

## help: Show this help message
help:
	@echo "AI Tour Meeting - Makefile Commands"
	@echo ""
	@echo "Usage:"
	@echo "  make <target> [OPTIONS]"
	@echo ""
	@echo "Targets:"
	@echo "  up             Start containers (with build)"
	@echo "  down           Stop and remove containers"
	@echo "  build          Build images only"
	@echo "  logs           Show container logs (follow mode)"
	@echo "  open           Open GUI in browser"
	@echo "  clean          Remove containers, volumes, and images"
	@echo "  run                  Run a Python script in the backend container"
	@echo "  gen-meetings         Generate a meeting scenario via LLM"
	@echo "  test                 Run all tests (frontend + backend)"
	@echo "  test-frontend        Run frontend tests in Docker"
	@echo "  test-frontend-watch  Run frontend tests in watch mode"
	@echo "  test-frontend-coverage Run frontend tests with coverage"
	@echo "  test-backend         Run backend (Python) tests in Docker"
	@echo "  test-backend-watch   Run backend tests with volume mount"
	@echo "  help                 Show this help message"
	@echo ""
	@echo "Options:"
	@echo "  OLLAMA=<spec>     Include Ollama. Formats:"
	@echo "                      cpu                    (CPU mode)"
	@echo "                      gpu                    (all GPUs)"
	@echo "                      gpu:0,1                (specific GPUs)"
	@echo "                      'gpu:0 gpu:1'          (multi-instance)"
	@echo "  VLLM=<spec>       Include vLLM (GPU required). Formats:"
	@echo "                      model                  (single GPU 0)"
	@echo "                      model:gpu=0,1          (tensor parallel)"
	@echo "                      'model1:gpu=0 model2:gpu=1' (multi-model)"
	@echo "  OPEN_GUI=1        Open browser after deployment"
	@echo "  DEBUG=1           Enable debug prompt logging (debug_prompts/prompts.jsonl)"
	@echo ""
	@echo "Examples:"
	@echo "  make up                                          # Basic deployment"
	@echo "  make up OLLAMA=cpu                               # Ollama CPU"
	@echo "  make up OLLAMA=gpu                               # Ollama all GPUs"
	@echo "  make up OLLAMA=gpu:0,1                           # Ollama specific GPUs"
	@echo "  make up OLLAMA='gpu:0 gpu:1'                     # Ollama multi-instance"
	@echo "  make up VLLM=Qwen/Qwen3-8B                      # vLLM single GPU"
	@echo "  make up VLLM='Qwen/Qwen3-8B:gpu=0,1'            # vLLM tensor parallel"
	@echo "  make up VLLM='model1:gpu=0 model2:gpu=1'        # vLLM multi-model"
	@echo "  make up OLLAMA='gpu:0 gpu:1' VLLM='m:gpu=2,3'   # Ollama + vLLM"
	@echo "  make up VLLM=Qwen/Qwen3-8B DEBUG=1            # vLLM with debug logging"
	@echo "  make down                         # Stop all containers"
	@echo "  make logs                         # View logs"
	@echo "  make test                         # Run all tests"
	@echo "  make test-frontend                # Run frontend tests only"
	@echo "  make test-backend                 # Run backend tests only"
	@echo "  make run SCRIPT=examples/barcelona.py                    # Run example meeting"
	@echo "  make run SCRIPT=examples/barcelona.py ARGS='--max-turns 10'"
	@echo "  make run SCRIPT=examples/barcelona.py ARGS='--model openai/gpt-5-mini-2025-08-07'"
	@echo "  make gen-meetings INSTRUCTION='3 people touring Kyoto' GEN_MODEL=openai/gpt-4o-mini"
	@echo "  make gen-meetings INSTRUCTION='Barcelona tour' GEN_MODEL=openai/gpt-4o-mini RUN=1"

---
name: ai-tour-meeting
description: >-
  Deploy and drive AI Tour Meeting (group travel planning by LLM agents):
  start/stop the Docker stack with make, run tour meetings from Python
  (build_meeting / run_cli / run_free_conversation), configure participants,
  meeting workflows, and context management, run batch experiments
  (gen-meetings / run-meetings / post-eval), add a human seat, and integrate
  external systems (ExternalSystem). Use when working with this repo's GUI,
  CLI, Python API, or evaluation workflows.
---

# AI Tour Meeting

Group travel planning framework where multiple persona-based LLM agents
discuss, ask each other questions, search the web, propose itineraries, and
vote until consensus. Components: React GUI (localhost:3000), FastAPI backend
(localhost:8080), and the `tour_meeting` Python package (engine).
Docs: https://ntt-dkiku.github.io/ai-tour-meeting/

## Deploy / operate the stack (make)

Requirements: Docker + Make. All services run in containers.

```bash
cp docker/.env.example docker/.env   # API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, HF_TOKEN)
                                     # optional: keys can instead be entered in the GUI Settings each session
make up                              # deploy; GUI at localhost:3000 (OPEN_GUI=1 opens browser)
make down                            # stop and remove containers
make build                           # rebuild images
make logs                            # container logs
make open                            # open the GUI in a browser
make clean                           # remove containers, volumes, images
make help                            # all commands with options
```

- Backend port defaults to 8080 (`BACKEND_PORT=9090 make up` to change).
- Remote server: forward ports `ssh <host> -L 3000:localhost:3000 -L 8080:localhost:8080`.

### Local LLMs

Add server options to `make up` (GPU modes are NVIDIA only):

```bash
make up OLLAMA=cpu                                    # Ollama, CPU mode
make up OLLAMA=gpu                                    # one Ollama server, all GPUs
make up OLLAMA="gpu:0,1 gpu:2,3"                      # separate servers per GPU set
make up VLLM=Qwen/Qwen3-8B                            # vLLM, single model
make up VLLM="Qwen/Qwen3-8B:gpu=0 openai/gpt-oss-20b:gpu=1"  # multiple models
```

Gated HF models (e.g., Llama) need `HF_TOKEN` in docker/.env. Server URLs are
resolved from `OLLAMA_BASE_{i}` / `VLLM_BASE_{i}` (fallback `OLLAMA_BASE` /
`VLLM_BASE`), where `{i}` is the server index — `make up` sets these for the
containers automatically.

## Run Python scripts

Scripts execute inside the backend container, so `make up` must be running:

```bash
make run SCRIPT=path/to/your_tour.py
make run SCRIPT=path/to/your_tour.py ARGS="--model openai/gpt-5.2"
```

Runnable examples in `examples/`: `barcelona.py` (basic meeting),
`external_system_demo.py` (external recommender takes a seat),
`external_advisor_demo.py` (seatless advisor), `run_paper_experiment.py`,
`analyze_results.py`.

## Batch experiments (scenario generation → runs → evaluation)

```bash
make gen-meetings INSTRUCTION="..." GEN_MODEL=<model> OUTPUT=meetings.json   # LLM-generate meeting scenarios (personas, goals, constraints)
make run-meetings MEETING=meetings.json MODEL=<model> OUTPUT=results.json    # run them; MODEL(s) are assigned to participants in order, cycled
make post-eval MEETING=meetings.json RESULTS=results.json OUTPUT=eval.json   # each participant re-scores the final itinerary (1-10 + reason)
```

Each target prints its full options when run without arguments.

## Python API

Entry point: `build_meeting` (tour_meeting/cli.py) → run with `run_cli()`
(prints the meeting to stdout) or iterate `run_free_conversation()` yourself.

```python
import asyncio
from tour_meeting.cli import build_meeting

meeting = build_meeting(
    title="One-Day Tokyo Tour",
    global_goals="Plan a fun one-day walking tour in Tokyo.",
    participants=[{...}, {...}],          # see "Participant config" below
    constraints={"travel_date": "2026-08-01", "time_window_start": "09:00",
                 "time_window_end": "18:00", "budget": "$100"},  # or a pre-formatted string
    settings={"max_turns": 100, "turn_rule": "round_robin", "voting_rule": "majority"},
)
asyncio.run(meeting.run_cli())
```

`participants` entries may be config dicts, ready-made `Participant`
instances, or one `ExternalSystem` instance (list position = speaking order).

### Participant config (dict keys)

Required: `name`, `model_name`, `background`, `personality`, `preferences`,
`personal_goals` (all non-empty strings).

Optional (default):

- `role` — `"attendee"` (default) or `"facilitator"` (picks the next speaker
  under the `facilitating` turn rule)
- `temperature` (0.7), `seed` (42), `max_tokens`, `max_context_length`,
  `reasoning_effort`
- `speaking_style` ("friendly"), `explanation_style` — `"auto"` (default) /
  `"subjective"` / `"contrastive"` / `"both"`
- `web_search` (False) — lets the agent search the web during its turn
- `max_steps` (5) — internal actions per turn (search/ask/reflect before
  concluding); also caps the human/external seat's ask steps
- `system_prompt` — fully replaces the default participant prompt; may use
  the same `{placeholder}` tokens (e.g. `{name}`, `{background}`)
- Context management: `context_mode` — `"auto_compact"` (default) /
  `"truncate"` / `"fixed_turns"` / `"none"`, with `auto_compact_threshold`
  (0.8), `auto_compact_target` (0.5), `compact_recent_ratio` (0.7),
  `fixed_turns_count` (10). auto_compact summarizes older turns when the
  context passes threshold × max_context_length; truncate drops them;
  fixed_turns keeps a sliding window on every turn.

### Meeting settings (dict keys)

- `turn_rule` — `"round_robin"` (default) / `"random"` / `"inviting"` (each
  speaker picks the next) / `"facilitating"` (the facilitator picks)
- `balanced_turns` (True) — everyone speaks once per round
- `volunteer_mode` (False) — agents may volunteer to speak
- `voting_rule` — `"majority"` (default) / `"unanimous"` / `"single_decider"`
  (set `single_decider` to a participant name) / `"most_pleasure"` /
  `"least_misery"` (score-based, 1-10)
- `vote_turn_rule` — `"round_robin"` (default) or `"parallel"` (all voters
  vote simultaneously; LLM-only meetings)
- `max_turns` (unlimited), `time_limit` (seconds)
- `human_role` — `"attendee"` (default) or `"facilitator"` (the human seat
  picks the next speaker)
- `deadlock_detection` — `{"enabled": True, "window": 3,
  "route_similarity_threshold": 0.8, "text_similarity_threshold": 0.8,
  "max_interventions": -1, "cooldown_turns": 6, "signals": [...]}`;
  when a stalemate is detected the engine injects a mediation message
  (emits `DeadlockIntervention`)
- `enable_post_eval` (True) — after consensus, each participant scores the
  final itinerary

All of these can also be passed directly as `run_free_conversation()`
arguments (direct args override settings).

### Running and consuming events

```python
async for event in meeting.run_free_conversation():
    ...
```

Yields typed events (tour_meeting/types.py): `MeetingStarted`, `TurnStart`,
`Delta` (streamed tokens + internal steps), `TurnFinal` (speaker, text,
route_plan, steps_log), `AskPending`/`AskExchange` (agent-to-agent Q&A),
`PhaseMessage`, `RoutePlanUpdate` (itinerary adopted), `ProposalVoteResult`,
`SatisfiedUpdate`, `RoundEnd`, `DeadlockIntervention`, `AdviceInjected`,
`RetryNotification`, `Timeout`, `MeetingFinished`, and the human/external-seat
events (`HumanTurn`, `HumanVote`, `HumanAsk`, `HumanSelectSpeaker` — aliased
`ExternalSystem*`). A meeting ends when all participants are satisfied AND a
proposal was accepted (consensus), or on `max_turns`/`time_limit`.

Control: `meeting.stop()` (graceful stop), `meeting.reset()` (clear history
for a rerun), `run_free_conversation(resume_from_history=True)` (continue an
earlier conversation).

### Results after a run

- `meeting.final_route` — the accepted itinerary as destination dicts
  (`name`, `description`, `transport_mode`, `transport_cost`,
  `travel_time_from_previous`, `start_time`, `stay_duration`, `cost`;
  costs are "symbol+number" strings like `"¥500"`), or None
- `meeting.get_conversation_history()` — `[{"speaker", "text", "turn"}, ...]`
- `meeting.get_analytics_summary()` / `meeting.export_analytics()` —
  discussion dynamics, proposals, votes, route transitions, termination reason

### Human in the loop

`meeting.enable_human(name="You")` adds a human seat; place it with
`meeting.set_order(["Alice", "__YOU__", "Bob"])` (`"__YOU__"` is the seat
sentinel). While iterating `run_free_conversation()`, respond to the events:

- `HumanTurn` → `meeting.submit_human({"action": "speak"|"ask"|"propose"|"satisfied",
  "message": ..., "target": ... (ask), "route": [dest dicts] (propose)})` —
  a multi-step loop: ask is intermediate (answer arrives via
  `event.ask_exchanges` on the next step), the final step must conclude
- `HumanVote` → `meeting.submit_human_vote({"accept": bool}` or
  `{"score": 1-10}, "message": ...})`
- `HumanAsk` → `meeting.submit_human_ask_answer(text)`
- `HumanSelectSpeaker` (facilitator) → `meeting.submit_human_selection(name)`

### External system integration (evaluation)

Subclass `tour_meeting.integration.ExternalSystem` and put the instance in
`participants` — callbacks are dispatched automatically by any run entry
point. Overriding `on_turn` takes a seat (implement `on_vote` too; optional
`on_ask`, `on_select_speaker`); overriding only `on_event` makes it a
seatless advisor that can call `self.advise(text)` (delivered to every agent
as a system message; emits `AdviceInjected`). Callbacks may be sync or async
and return typed actions from `tour_meeting.types`: `Speak`, `Ask`,
`Propose`, `Satisfied`, `Vote`. `RouteDraft` (`message` + `route`) doubles as
a structured-output target for LLM-backed systems. Events carry
`conversation_history`, `ask_exchanges`, `current_route`, `candidates`,
`step`/`max_steps`/`can_ask`. Full I/O reference: docs "Evaluate your system"
page; working code: `examples/external_system_demo.py`,
`examples/external_advisor_demo.py`; tests: `tests/test_external_system.py`.

### Model names

litellm-style prefixes are required; a bare name falls through to the vLLM
route and will fail to connect. gpt-5-family models only accept
`temperature: 1`.

- Commercial: `openai/gpt-5.2`, `anthropic/claude-...`, `google/gemini-...`
- Ollama: `ollama/{i}/{model}` (e.g. `ollama/0/llama3:8b`; `{i}` = server
  index, omittable for server 0). `ollama_chat/...` uses the chat endpoint.
  The model must already be pulled on that server, or `load_llm` raises
  ModelNotFoundError (`tour_meeting.llm.pull_ollama_model` can pull it).
- vLLM: `vllm/{i}/{model}` (e.g. `vllm/0/Qwen/Qwen3-8B`) — must match a model
  the vLLM server was started with (the `VLLM=` option to `make up`).

## Testing

```bash
make test            # frontend (vitest) + backend (pytest) in containers
make test-backend    # backend only; -watch and frontend -coverage variants exist
pytest tests/        # direct; LLM calls are mocked, no API keys needed
```

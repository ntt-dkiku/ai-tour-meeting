import json
import logging
import os
import re
import requests
import shutil
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterator, List, Optional

import litellm
import openai
from pydantic import BaseModel

from .messages import AIMessage, HumanMessage

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# LLM response cache (disk-backed, opt-out via LITELLM_CACHE=0)
# ---------------------------------------------------------------------------
_CACHE_DIR = Path(__file__).resolve().parent.parent / ".litellm_cache"

if os.getenv("LITELLM_CACHE", "1") != "0":
    try:
        from litellm import Cache
        litellm.cache = Cache(type="disk", disk_cache_dir=str(_CACHE_DIR))
        try:
            # diskcache defaults to a 1 GB size limit with LRU eviction, which
            # silently evicts old runs' responses and breaks deterministic
            # replay. Raise it (LITELLM_CACHE_GB to override, default 50 GB).
            _size_gb = float(os.getenv("LITELLM_CACHE_GB", "50"))
            litellm.cache.cache.disk_cache.reset("size_limit", int(_size_gb * 2**30))
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Could not raise litellm cache size limit: %s", exc)
        logger.info("litellm disk cache enabled at %s", _CACHE_DIR)
    except Exception as exc:
        logger.warning("Failed to enable litellm cache: %s", exc)


# ---------------------------------------------------------------------------
# Debug prompt logging (opt-in via DEBUG_PROMPTS=1)
# ---------------------------------------------------------------------------
_DEBUG_PROMPTS_DIR = Path(__file__).resolve().parent.parent / "debug_prompts"
_debug_prompts_lock = threading.Lock()
_debug_prompts_seq = 0


def _is_debug_prompts_enabled() -> bool:
    return os.getenv("DEBUG_PROMPTS", "0") == "1"


class _PromptDebugLogger(litellm.integrations.custom_logger.CustomLogger):
    """Logs every litellm call's input/output to a JSONL file."""

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._write(kwargs, response_obj, start_time, end_time)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._write(kwargs, response_obj, start_time, end_time)

    def _write(self, kwargs, response_obj, start_time, end_time):
        global _debug_prompts_seq
        if not _is_debug_prompts_enabled():
            return
        try:
            _DEBUG_PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
            with _debug_prompts_lock:
                _debug_prompts_seq += 1
                seq = _debug_prompts_seq

            messages = kwargs.get("messages", [])
            model = kwargs.get("model", "")
            # Extract response content
            resp_content = ""
            if response_obj and hasattr(response_obj, "choices") and response_obj.choices:
                resp_content = getattr(response_obj.choices[0].message, "content", "") or ""

            record = {
                "seq": seq,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "model": model,
                "messages": messages,
                "response": resp_content,
                "duration_ms": int((end_time - start_time).total_seconds() * 1000),
            }

            log_file = _DEBUG_PROMPTS_DIR / "prompts.jsonl"
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception:
            logger.debug("Failed to write debug prompt log", exc_info=True)


# Register the callback (always register, but only writes when enabled)
litellm.callbacks = litellm.callbacks or []
litellm.callbacks.append(_PromptDebugLogger())


def clear_llm_cache() -> bool:
    """Delete the disk cache directory and re-initialise. Returns True if cleared."""
    if _CACHE_DIR.is_dir():
        shutil.rmtree(_CACHE_DIR)
        if litellm.cache is not None:
            try:
                from litellm import Cache
                litellm.cache = Cache(type="disk", disk_cache_dir=str(_CACHE_DIR))
            except Exception:
                pass
        return True
    return False


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class ModelNotFoundError(LookupError):
    pass


# ---------------------------------------------------------------------------
# LLM Configuration
# ---------------------------------------------------------------------------
@dataclass
class LLMConfig:
    """Configuration for a litellm-backed model."""
    model: str
    temperature: float = 0.0
    seed: Optional[int] = None
    max_tokens: Optional[int] = None
    api_base: Optional[str] = None
    api_key: Optional[str] = None
    max_context_length: Optional[int] = None
    reasoning_effort: Optional[str] = None


# Backward-compatible alias
LLM = LLMConfig


# ---------------------------------------------------------------------------
# Ollama helpers (no LangChain dependency)
# ---------------------------------------------------------------------------
def verify_model_name(model_name: str, base_url: Optional[str] = None) -> bool:
    if base_url:
        resp = requests.get(f"{base_url}/api/tags")
    else:
        resp = requests.get(f"http://localhost:11434/api/tags")
    resp.raise_for_status()
    data = resp.json()
    return any(model.get("name") == model_name for model in data.get("models", []))


def list_ollama_models(base_url: Optional[str] = None) -> List[Dict]:
    """List all available Ollama models."""
    try:
        if base_url:
            resp = requests.get(f"{base_url}/api/tags")
        else:
            resp = requests.get(f"http://localhost:11434/api/tags")
        resp.raise_for_status()
        data = resp.json()
        return data.get("models", [])
    except Exception:
        return []


def pull_ollama_model(model_name: str, base_url: Optional[str] = None) -> Iterator[Dict]:
    """Pull an Ollama model and yield progress updates."""
    try:
        if base_url:
            url = f"{base_url}/api/pull"
        else:
            url = "http://localhost:11434/api/pull"

        resp = requests.post(url, json={"name": model_name}, stream=True)
        resp.raise_for_status()

        for line in resp.iter_lines():
            if line:
                yield json.loads(line)
    except Exception as e:
        yield {"error": str(e)}


# ---------------------------------------------------------------------------
# load_llm  –  returns LLMConfig instead of a LangChain Runnable
# ---------------------------------------------------------------------------
def load_llm(
    model_name: str,
    temperature: float = 0.0,
    port: int = 8000,
    seed: int = 42,
    max_context_length: Optional[int] = None,
    max_tokens: Optional[int] = None,
    reasoning_effort: Optional[str] = None,
) -> LLMConfig:
    if model_name.startswith("openai/"):
        return LLMConfig(
            model=model_name,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            seed=seed,
            max_tokens=max_tokens,
            max_context_length=max_context_length,
        )
    elif model_name.startswith("google/"):
        bare_model = model_name.split("google/", 1)[1]
        return LLMConfig(
            model=f"gemini/{bare_model}",
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            max_tokens=max_tokens,
            max_context_length=max_context_length,
        )
    elif model_name.startswith("anthropic/"):
        return LLMConfig(
            model=model_name,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            max_tokens=max_tokens if max_tokens is not None else 8192,
            max_context_length=max_context_length,
        )
    elif model_name.startswith("ollama/"):
        remainder = model_name.split("ollama/", 1)[1]
        # New format: ollama/{index}/{model}  e.g. ollama/0/llama3:8b
        # Backward compat: ollama/{model}     e.g. ollama/llama3:8b
        parts = remainder.split("/", 1)
        if len(parts) >= 2 and parts[0].isdigit():
            index = int(parts[0])
            bare_model = parts[1]
        else:
            index = 0
            bare_model = remainder
        base_url = (
            os.getenv(f"OLLAMA_BASE_{index}")
            or os.getenv("OLLAMA_BASE", "http://localhost:11434")
        )
        model_exists = verify_model_name(bare_model, base_url=base_url)
        if not model_exists:
            raise ModelNotFoundError(f"{model_name} was not found in the available list.")
        return LLMConfig(
            model=f"ollama/{bare_model}",
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            seed=seed,
            max_tokens=max_tokens,
            api_base=base_url,
            max_context_length=max_context_length,
        )
    elif model_name.startswith("ollama_chat/"):
        remainder = model_name.split("ollama_chat/", 1)[1]
        # New format: ollama_chat/{index}/{model}
        # Backward compat: ollama_chat/{model}
        parts = remainder.split("/", 1)
        if len(parts) >= 2 and parts[0].isdigit():
            index = int(parts[0])
            bare_model = parts[1]
        else:
            index = 0
            bare_model = remainder
        base_url = (
            os.getenv(f"OLLAMA_BASE_{index}")
            or os.getenv("OLLAMA_BASE", "http://localhost:11434")
        )
        return LLMConfig(
            model=f"ollama_chat/{bare_model}",
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            seed=seed,
            max_tokens=max_tokens,
            api_base=base_url,
            max_context_length=max_context_length,
        )
    elif model_name.startswith("vllm/"):
        remainder = model_name.split("vllm/", 1)[1]
        # New format: vllm/{index}/{model}  e.g. vllm/0/Qwen/Qwen3-8B
        # Backward compat: vllm/{model}     e.g. vllm/Qwen/Qwen3-8B
        parts = remainder.split("/", 1)
        if len(parts) >= 2 and parts[0].isdigit():
            index = int(parts[0])
            bare_model = parts[1]
        else:
            index = 0
            bare_model = remainder
        base_url = (
            os.getenv(f"VLLM_BASE_{index}")
            or os.getenv("VLLM_BASE", f"http://localhost:{port}/v1")
        )
        return LLMConfig(
            model=f"openai/{bare_model}",
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            max_tokens=max_tokens if max_tokens is not None else 8192,
            seed=seed,
            api_base=base_url,
            api_key="EMPTY",
            max_context_length=max_context_length,
        )
    else:
        # vLLM or other OpenAI-compatible endpoint
        base_url = os.getenv("VLLM_BASE", f"http://localhost:{port}/v1")
        return LLMConfig(
            model=f"openai/{model_name}",
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            max_tokens=max_tokens if max_tokens is not None else 8192,
            seed=seed,
            api_base=base_url,
            api_key="EMPTY",
            max_context_length=max_context_length,
        )


# ---------------------------------------------------------------------------
# Helper: query litellm model metadata (max tokens, context length)
# ---------------------------------------------------------------------------
def get_commercial_model_info(model_name: str) -> Optional[Dict[str, Optional[int]]]:
    """Return ``{max_input_tokens, max_output_tokens}`` for a known model.

    *model_name* uses the frontend naming convention
    (``openai/…``, ``google/…``, ``anthropic/…``).  The function tries several
    litellm name variants and returns ``None`` when nothing matches.
    """
    # Build candidate names that litellm might recognise
    candidates: list[str] = [model_name]
    if model_name.startswith("google/"):
        bare = model_name.split("google/", 1)[1]
        candidates.append(f"gemini/{bare}")
        candidates.append(bare)
    elif model_name.startswith("openai/"):
        bare = model_name.split("openai/", 1)[1]
        candidates.append(bare)
    elif model_name.startswith("anthropic/"):
        bare = model_name.split("anthropic/", 1)[1]
        candidates.append(bare)

    for candidate in candidates:
        try:
            info = litellm.get_model_info(candidate)
            return {
                "max_input_tokens": info.get("max_input_tokens"),
                "max_output_tokens": info.get("max_output_tokens"),
            }
        except Exception:
            continue
    return None


# ---------------------------------------------------------------------------
# Helper: build kwargs for litellm.acompletion / litellm.completion
# ---------------------------------------------------------------------------
def build_litellm_kwargs(llm_config: LLMConfig) -> dict:
    """Build keyword arguments for ``litellm.acompletion`` from an LLMConfig."""
    kwargs: dict = {
        "model": llm_config.model,
        "temperature": llm_config.temperature,
    }
    if llm_config.max_tokens is not None:
        kwargs["max_tokens"] = llm_config.max_tokens
    if llm_config.seed is not None:
        kwargs["seed"] = llm_config.seed
    if llm_config.reasoning_effort:
        kwargs["reasoning_effort"] = llm_config.reasoning_effort
    if llm_config.api_base:
        kwargs["api_base"] = llm_config.api_base
    if llm_config.api_key:
        kwargs["api_key"] = llm_config.api_key
    return kwargs


# ---------------------------------------------------------------------------
# Helper: safe template substitution
# ---------------------------------------------------------------------------
_PLACEHOLDER_RE = re.compile(r"\{(\w+)\}")


def safe_format(template: str, mapping: dict) -> str:
    """Substitute ``{key}`` placeholders without raising on unknowns.

    Unlike ``str.format``, this only replaces ``{identifier}`` tokens whose key
    exists in *mapping*; any other braces (literal ``{``/``}``, JSON snippets, or
    unknown ``{placeholders}``) are left untouched.  This makes it safe to apply
    to user-provided text such as a custom system-prompt override.
    """
    def _repl(match: "re.Match") -> str:
        key = match.group(1)
        if key in mapping:
            return str(mapping[key])
        return match.group(0)

    return _PLACEHOLDER_RE.sub(_repl, template)


# ---------------------------------------------------------------------------
# Helper: build litellm messages from templates + history
# ---------------------------------------------------------------------------
def build_messages(
    system_template: str,
    history: List,
    payload: dict,
    format_instructions: str,
    human_template: Optional[str] = None,
    enables_prefill: bool = False,
    prefill_field_names: Optional[List[str]] = None,
) -> list:
    """Build a list of litellm message dicts from templates, history, and payload.

    ``payload`` values are substituted into *system_template* and *human_template*
    via :func:`safe_format`.  The special key ``history`` is excluded from the
    format dict so it does not collide with the placeholder list.  Unknown
    ``{placeholders}`` and literal braces in the templates are preserved as-is,
    which keeps custom system-prompt overrides from raising on stray braces.
    """
    fmt = {**payload, "format_instructions": format_instructions}
    fmt.pop("history", None)

    system_content = safe_format(system_template, fmt)
    messages: list = [{"role": "system", "content": system_content}]

    # Insert conversation history
    for msg in (history or []):
        if isinstance(msg, HumanMessage):
            messages.append(msg.to_litellm_dict())
        elif isinstance(msg, AIMessage):
            messages.append(msg.to_litellm_dict())
        elif isinstance(msg, dict):
            messages.append(msg)

    # Human message
    if human_template:
        human_content = safe_format(human_template, fmt)
        messages.append({"role": "user", "content": human_content})

    # Prefill for Anthropic-style models
    if enables_prefill and prefill_field_names:
        first_key = str(prefill_field_names[0])
        prefill_str = '```json\n{"' + first_key + '":'
        messages.append({"role": "assistant", "content": prefill_str})

    return messages


# ---------------------------------------------------------------------------
# JSON extraction from LLM response text
# ---------------------------------------------------------------------------
def _balanced_json_spans(text: str) -> List[tuple]:
    """Return (start, substring) for every top-level balanced {...} in text.

    String-aware, so braces inside JSON string values don't break the scan.
    """
    spans: List[tuple] = []
    depth = 0
    start = -1
    in_string = False
    escaped = False
    for i, ch in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            if depth > 0:
                in_string = True
        elif ch == '{':
            if depth == 0:
                start = i
            depth += 1
        elif ch == '}':
            if depth > 0:
                depth -= 1
                if depth == 0 and start != -1:
                    spans.append((start, text[start:i + 1]))
                    start = -1
    return spans


def extract_json(text: str) -> dict:
    """Extract a JSON object from LLM response text.

    Handles markdown code-blocks, raw JSON, and common formatting quirks.
    Candidates are tried from the END of the text backwards: reasoning-style
    models often write draft/example JSON while thinking and emit the real
    answer last, so the earlier drafts must not win.
    """
    text = text.strip()

    # 0) Strip <think>...</think> blocks (e.g. Qwen3 reasoning)
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()

    # Collect candidates with their positions: fenced code blocks and any
    # top-level balanced {...} object in the raw text.
    candidates: List[tuple] = []
    for match in re.finditer(r'```(?:json)?\s*([\[{].*?[\]}])\s*```', text, re.DOTALL):
        candidates.append((match.start(1), match.group(1)))
    candidates.extend(_balanced_json_spans(text))

    for _, candidate in sorted(candidates, key=lambda item: -item[0]):
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, (dict, list)):
            return parsed

    raise ValueError(f"Could not extract JSON from response: {text[:300]}...")


# ---------------------------------------------------------------------------
# Format instructions (replaces JsonOutputParser.get_format_instructions)
# ---------------------------------------------------------------------------
def get_format_instructions(pydantic_class: type) -> str:
    """Generate JSON format instructions from a Pydantic model schema."""
    schema = pydantic_class.model_json_schema()
    return (
        "The output should be formatted as a JSON instance that conforms to the "
        "JSON schema below.\n\n"
        "As an example, for the schema "
        '{"properties": {"foo": {"title": "Foo", "description": "a list of strings", '
        '"type": "array", "items": {"type": "string"}}}, "required": ["foo"]}\n'
        'the object {"foo": ["bar", "baz"]} is a well-formatted instance of the schema. '
        'The object {"properties": {"foo": ["bar", "baz"]}} is not well-formatted.\n\n'
        f"Here is the output schema:\n```\n{json.dumps(schema)}\n```"
    )


# ---------------------------------------------------------------------------
# Token usage tracking  –  uses litellm response.usage directly
# ---------------------------------------------------------------------------
class TokenUsage(BaseModel):
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    total_tokens: int


class LLMLog(BaseModel):
    agent_name: str
    token_usage: TokenUsage
    message_history: list


class TokenTracker:
    """Track token usage from litellm responses."""

    def __init__(self, agent_name: str):
        self.agent_name = agent_name
        self.token_usage = TokenUsage(input_tokens=0, output_tokens=0, cached_tokens=0, total_tokens=0)
        self.message_history: list = []
        self.log = LLMLog(
            agent_name=agent_name,
            token_usage=self.token_usage,
            message_history=self.message_history,
        )

    def record_usage(self, response) -> None:
        """Record token usage from a non-streaming litellm response."""
        usage = getattr(response, "usage", None)
        if usage:
            self.token_usage.input_tokens += getattr(usage, "prompt_tokens", 0) or 0
            self.token_usage.output_tokens += getattr(usage, "completion_tokens", 0) or 0
            self.token_usage.total_tokens += getattr(usage, "total_tokens", 0) or 0
            # Extract cached tokens from prompt_tokens_details (OpenAI / litellm)
            details = getattr(usage, "prompt_tokens_details", None)
            if details:
                self.token_usage.cached_tokens += getattr(details, "cached_tokens", 0) or 0
        self._update_log()

    def record_streaming_usage(self, chunks: list) -> None:
        """Record token usage from streaming chunks via litellm.stream_chunk_builder."""
        try:
            resp = litellm.stream_chunk_builder(chunks)
            self.record_usage(resp)
        except Exception:
            # Fallback: some providers may not include usage in stream chunks
            pass

    def record_content(self, content: str) -> None:
        """Append generated content to message history."""
        self.message_history.append(content)
        self._update_log()

    def _update_log(self) -> None:
        self.log = LLMLog(
            agent_name=self.agent_name,
            token_usage=self.token_usage,
            message_history=self.message_history,
        )


# ---------------------------------------------------------------------------
# Pricing
# ---------------------------------------------------------------------------
UNIT = 1e+6
PRICING_PER_TOKEN = {
    "openai/gpt-4o-2024-08-06": {
        "input": 2.50 / UNIT,
        "output": 10. / UNIT
    },
    "openai/gpt-4o-2024-05-13": {
        "input": 5.00 / UNIT,
        "output": 15.00 / UNIT
    },
    "openai/gpt-4o-mini-2024-07-18": {
        "input": 0.15 / UNIT,
        "output": 0.6 / UNIT
    },
    "google/gemini-1.5-pro-latest": {
        "input": 3.50 / UNIT,
        "output": 10.50 / UNIT
    },
    "google/gemini-1.5-pro": {
        "input": 3.50 / UNIT,
        "output": 10.50 / UNIT
    },
    "anthropic/claude-3-5-sonnet-20241022": {
        "input": 3.75 / UNIT,
        "output": 15. / UNIT
    },
    "anthropic/claude-3-5-sonnet-20240620": {
        "input": 3.75 / UNIT,
        "output": 15. / UNIT
    },
}


# ---------------------------------------------------------------------------
# API key utilities (no LangChain dependency)
# ---------------------------------------------------------------------------
def verify_api_key(provider: str, api_key: str) -> bool:
    if not api_key:
        return False
    try:
        if provider == "openai":
            client = openai.OpenAI(api_key=api_key)
            try:
                client.models.list()
            except openai.AuthenticationError:
                return False
            else:
                return True
        elif provider == "anthropic":
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01"
            }
            response = requests.get(
                "https://api.anthropic.com/v1/models",
                headers=headers,
                timeout=5
            )
            return response.status_code == 200
        elif provider == "google":
            response = requests.get(
                f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}",
                timeout=5
            )
            return response.status_code == 200
    except Exception:
        return False
    return False


def get_env_key_name(provider: str) -> str:
    env_keys = {
        "openai": "OPENAI_API_KEY",
        "google": "GOOGLE_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY"
    }
    return env_keys.get(provider, "API_KEY")


def check_existing_key(provider: str) -> bool:
    env_key_name = get_env_key_name(provider)
    existing_key = os.environ.get(env_key_name)
    if existing_key:
        if verify_api_key(provider, existing_key):
            return True
    return False

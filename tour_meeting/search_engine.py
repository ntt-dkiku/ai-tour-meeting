from __future__ import annotations

import logging
from typing import Any, Dict, List, Sequence, cast

import litellm

# Ensure litellm cache initialization side effects from llm.py are applied.
from . import llm as _llm_cache_bootstrap  # noqa: F401

logger = logging.getLogger(__name__)

SEARCH_SYSTEM_INSTRUCTIONS = (
    "You are a web-search assistant. Answer only what the user explicitly asked. "
    "NEVER ask follow-up questions unless the request is impossible to answer anything. "
    "If key facts are missing, state the limitation briefly and provide the best possible direct answer. "
    "Keep responses concise and factual."
)
SEARCH_PROMPT_VERSION = "search-instr-v2"


def _flatten_response_text(response: object) -> str:
    """Extract human-readable text from an OpenAI response object."""
    lines: List[str] = []
    output_text = getattr(response, "output_text", None)
    if isinstance(output_text, str) and output_text.strip():
        lines.append(output_text.strip())
    return "\n".join(lines).strip()


def _obj_to_dict(entry: object) -> Dict[str, Any] | None:
    if isinstance(entry, dict):
        return cast(Dict[str, Any], entry)
    if hasattr(entry, "model_dump") and callable(getattr(entry, "model_dump")):
        try:
            dumped = entry.model_dump()  # type: ignore[call-arg]
            if isinstance(dumped, dict):
                return cast(Dict[str, Any], dumped)
        except Exception:
            return None
    if hasattr(entry, "to_dict") and callable(getattr(entry, "to_dict")):
        try:
            dumped = entry.to_dict()  # type: ignore[call-arg]
            if isinstance(dumped, dict):
                return cast(Dict[str, Any], dumped)
        except Exception:
            return None
    return None


def _extract_search_text(entry: object) -> List[str]:
    lines: List[str] = []
    if isinstance(entry, str):
        if entry.strip():
            lines.append(entry.strip())
        return lines
    if isinstance(entry, Sequence) and not isinstance(entry, (dict, BaseException)):
        for part in entry:
            lines.extend(_extract_search_text(part))
        return lines
    entry_dict = _obj_to_dict(entry)
    if entry_dict is not None:
        if entry_dict.get("type") == "web_search_call":
            return lines
        for key in ("text", "message"):
            value = entry_dict.get(key)
            if isinstance(value, str) and value.strip():
                lines.append(value.strip())
        content = entry_dict.get("content")
        if isinstance(content, Sequence):
            for chunk in content:
                lines.extend(_extract_search_text(chunk))
    return lines


def _dedupe_preserve_order(items: List[str]) -> List[str]:
    seen: set[str] = set()
    deduped: List[str] = []
    for item in items:
        key = item.strip()
        if not key:
            continue
        if key in seen:
            continue
        seen.add(key)
        deduped.append(key)
    return deduped


def _create_response(request_params: Dict[str, Any]) -> object:
    # Only use LiteLLM path so search calls always go through cache-aware code.
    responses_obj = getattr(litellm, "responses", None)
    if responses_obj is not None:
        create_fn = getattr(responses_obj, "create", None)
        if callable(create_fn):
            return create_fn(**request_params)
        if callable(responses_obj):
            return responses_obj(**request_params)
    response_fn = getattr(litellm, "response", None)
    if callable(response_fn):
        return response_fn(**request_params)
    raise RuntimeError("LiteLLM responses API is not available in this environment.")


def gpt5_search_sync(
    query: str,
    *,
    max_results: int = 3,
    model: str = "gpt-5-nano-2025-08-07", #"gpt-5-mini-2025-08-07",
    reasoning: dict | None = {"effort": "low"},
    allowed_domains: list[str] | None = None,
    user_location: dict | None = None,
    external_web_access: bool | None = None,
    tool_choice: str = "auto",
    messages: list[dict] | None = None,
) -> str:
    """
    Run a natural-language query against the gpt-5 web search tool via LiteLLM.

    Args:
        query: The natural language question to ask.
        max_results: Target number of results the model should return.
        model: The OpenAI model to use (defaults to `gpt-5`).
        reasoning: Optional reasoning effort configuration.
        allowed_domains: Optional domain allow-list for the web search tool (max 20 entries).
        user_location: Optional geographic hint (`country`, `city`, `region`, `timezone`).
        external_web_access: Set to `False` to force cache-only mode.
        tool_choice: Tool selection strategy passed to the Responses API.
        messages: Optional conversation history (list of dicts with "role" and "content" keys).
    """
    keywords = (query or "").strip()
    if not keywords:
        return "Search skipped: empty query."
    tool_config: dict[str, object] = {"type": "web_search"}
    if allowed_domains:
        tool_config["filters"] = {"allowed_domains": allowed_domains}
    if user_location:
        tool_config["user_location"] = user_location
    if external_web_access is not None:
        tool_config["external_web_access"] = external_web_access

    try:
        # Build request parameters
        request_params = {
            "model": model,
            "tools": [tool_config],
            "tool_choice": tool_choice,
            "reasoning": reasoning,
            "instructions": SEARCH_SYSTEM_INSTRUCTIONS,
            # Make prompt revisions explicit to avoid stale cache hits on first query.
            "user": SEARCH_PROMPT_VERSION,
            "metadata": {"search_prompt_version": SEARCH_PROMPT_VERSION},
            "include": ["web_search_call.action.sources"],
        }

        # gpt-5-nano does not support messages parameter, only input
        # Other gpt-5 models support both
        is_nano = "nano" in model.lower()

        if messages and not is_nano:
            # Use messages for conversation history (supported by mini and larger models)
            full_messages = list(messages) + [{"role": "user", "content": keywords}]
            request_params["messages"] = full_messages
        else:
            # Use input for single query (supported by all models including nano)
            request_params["input"] = keywords

        response = _create_response(request_params)
    except Exception as exc:  # pragma: no cover - depends on external service
        logger.exception("gpt-5 search request failed for query %s", keywords)
        return f"gpt-5 search error: {exc}"

    lines: List[str] = []
    flattened = _flatten_response_text(response)
    if flattened:
        lines.append(flattened)
    output = getattr(response, "output", None)
    if isinstance(output, Sequence):
        for entry in output:
            lines.extend(_extract_search_text(entry))
    lines = _dedupe_preserve_order(lines)
    if not lines:
        lines.append("No gpt-5 search results were returned.")

    call_entries: list[dict[str, object]] = []
    if isinstance(output, Sequence):
        for entry in output:
            entry_dict = _obj_to_dict(entry)
            if entry_dict and entry_dict.get("type") == "web_search_call":
                call_entries.append(cast(dict[str, object], entry_dict))

    header = f"gpt-5 search results for '{keywords}'"
    header += ":"

    if not lines:
        lines.append("No gpt-5 search results were returned.")
    return f"{header}\n" + "\n".join(lines)

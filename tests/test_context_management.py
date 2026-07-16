"""Tests for context management summarization in Participant.

Covers the condition branches in _summarize_history and _summarize_history_incremental:
1. JSON parse success + tokens within budget → return summary
2. JSON parse success + tokens over budget → LLMParseError (retry)
3. JSON parse failure + finish_reason="length" → LLMParseError with truncation message (retry)
4. JSON parse failure + finish_reason="stop" → LLMParseError with parse error (retry)
5. Retry succeeds after initial failure
"""

import json
import os
import pytest
import pytest_asyncio
import requests
from unittest.mock import AsyncMock, MagicMock, patch

pytestmark = pytest.mark.asyncio(loop_scope="function")

import litellm
from tour_meeting.participant import Participant, LLMParseError
from tour_meeting.messages import HumanMessage
from tour_meeting.llm import LLMConfig
from tour_meeting.tour_meeting import AITourMeeting

# vLLM integration test configuration
VLLM_BASE = os.environ.get("VLLM_BASE", "http://vllm-0:8000/v1")
VLLM_MODEL = "openai/Qwen/Qwen3-8B"
VLLM_API_KEY = "EMPTY"


def _vllm_available() -> bool:
    """Check if vLLM is reachable."""
    try:
        resp = requests.get(f"{VLLM_BASE}/models", timeout=3)
        return resp.status_code == 200
    except Exception:
        return False


def _make_participant(**kwargs):
    """Create a minimal Participant for testing."""
    llm = LLMConfig(
        model="test-model",
        temperature=0.0,
        max_context_length=4096,
    )
    return Participant(
        llm=llm,
        name="TestAgent",
        background="A test participant",
        personality="Curious",
        preferences="Efficient discussions",
        personal_goals="Testing",
        max_retries=kwargs.pop("max_retries", 3),
        retry_delay=kwargs.pop("retry_delay", 0.0),  # No wait in tests
        **kwargs,
    )


def _make_response(content: str, finish_reason: str = "stop", has_finish_reason: bool = True):
    """Build a mock litellm response object."""
    choice = MagicMock(spec=["message"])  # spec limits attributes
    choice.message = MagicMock()
    choice.message.content = content
    if has_finish_reason:
        choice.finish_reason = finish_reason

    usage = MagicMock()
    usage.prompt_tokens = 10
    usage.completion_tokens = 5
    usage.total_tokens = 15

    response = MagicMock()
    response.choices = [choice]
    response.usage = usage
    return response


def _make_messages(n: int = 3):
    """Create a list of HumanMessages for summarization input."""
    return [
        HumanMessage(content=f"Message {i} content", name=f"Speaker{i}")
        for i in range(n)
    ]


# ---------------------------------------------------------------------------
# _summarize_history
# ---------------------------------------------------------------------------
class TestSummarizeHistory:
    """Tests for _summarize_history condition branches."""

    @pytest.mark.asyncio
    async def test_success_within_budget(self):
        """JSON parses OK and tokens within budget → returns summary string."""
        p = _make_participant()
        messages = _make_messages()
        short_summary = "Brief meeting summary."
        response_content = json.dumps({"summary": short_summary})

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = _make_response(response_content, "stop")
            result = await p._summarize_history(messages, summary_budget=500)

        assert result == short_summary
        mock_llm.assert_called_once()

    @pytest.mark.asyncio
    async def test_tokens_over_budget_triggers_retry(self):
        """JSON parses OK but tokens exceed budget → retries, then succeeds."""
        p = _make_participant(max_retries=2, retry_delay=0.0)
        messages = _make_messages()

        long_summary = "word " * 200  # ~200 tokens, will exceed small budget
        short_summary = "Short."
        long_response = json.dumps({"summary": long_summary})
        short_response = json.dumps({"summary": short_summary})

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.side_effect = [
                _make_response(long_response, "stop"),
                _make_response(short_response, "stop"),
            ]
            result = await p._summarize_history(messages, summary_budget=50)

        assert result == short_summary
        assert mock_llm.call_count == 2

    @pytest.mark.asyncio
    async def test_tokens_over_budget_all_retries_fail(self):
        """JSON parses OK but tokens always exceed budget → raises after all retries."""
        p = _make_participant(max_retries=2, retry_delay=0.0)
        messages = _make_messages()

        long_summary = "word " * 200
        long_response = json.dumps({"summary": long_summary})

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = _make_response(long_response, "stop")
            with pytest.raises(LLMParseError, match="Summary too long"):
                await p._summarize_history(messages, summary_budget=50)

        assert mock_llm.call_count == 2

    @pytest.mark.asyncio
    async def test_json_truncated_by_max_tokens(self):
        """JSON broken + finish_reason='length' → error mentions truncation, retries."""
        p = _make_participant(max_retries=2, retry_delay=0.0)
        messages = _make_messages()

        truncated_json = '{"summary": "This is a truncated summ'
        valid_response = json.dumps({"summary": "Fixed."})

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.side_effect = [
                _make_response(truncated_json, "length"),  # Truncated
                _make_response(valid_response, "stop"),    # Retry succeeds
            ]
            result = await p._summarize_history(messages, summary_budget=500)

        assert result == "Fixed."
        assert mock_llm.call_count == 2

    @pytest.mark.asyncio
    async def test_json_truncated_all_retries_fail(self):
        """JSON broken + finish_reason='length' on all retries → raises with truncation message."""
        p = _make_participant(max_retries=2, retry_delay=0.0)
        messages = _make_messages()
        truncated_json = '{"summary": "This is a truncated summ'

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = _make_response(truncated_json, "length")
            with pytest.raises(LLMParseError, match="Output truncated by max_tokens"):
                await p._summarize_history(messages, summary_budget=500)

        assert mock_llm.call_count == 2

    @pytest.mark.asyncio
    async def test_json_parse_error_not_truncated(self):
        """JSON broken + finish_reason='stop' → generic parse error, retries."""
        p = _make_participant(max_retries=2, retry_delay=0.0)
        messages = _make_messages()

        bad_json = "Not valid JSON at all"
        valid_response = json.dumps({"summary": "Recovered."})

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.side_effect = [
                _make_response(bad_json, "stop"),
                _make_response(valid_response, "stop"),
            ]
            result = await p._summarize_history(messages, summary_budget=500)

        assert result == "Recovered."
        assert mock_llm.call_count == 2

    @pytest.mark.asyncio
    async def test_json_parse_error_all_retries_fail(self):
        """JSON broken + finish_reason='stop' on all retries → raises parse error (not truncation)."""
        p = _make_participant(max_retries=2, retry_delay=0.0)
        messages = _make_messages()
        bad_json = "Not valid JSON at all"

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = _make_response(bad_json, "stop")
            with pytest.raises(LLMParseError) as exc_info:
                await p._summarize_history(messages, summary_budget=500)
            assert "truncated" not in str(exc_info.value).lower()

        assert mock_llm.call_count == 2

    @pytest.mark.asyncio
    async def test_missing_finish_reason_attribute(self):
        """Response without finish_reason attr + broken JSON → generic parse error, not truncation."""
        p = _make_participant(max_retries=2, retry_delay=0.0)
        messages = _make_messages()

        bad_json = '{"summary": "incomplete'
        valid_response = json.dumps({"summary": "Recovered."})

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.side_effect = [
                _make_response(bad_json, has_finish_reason=False),  # No finish_reason attr
                _make_response(valid_response, "stop"),
            ]
            result = await p._summarize_history(messages, summary_budget=500)

        assert result == "Recovered."
        assert mock_llm.call_count == 2

    @pytest.mark.asyncio
    async def test_missing_finish_reason_does_not_claim_truncation(self):
        """Response without finish_reason attr → error message should NOT mention truncation."""
        p = _make_participant(max_retries=2, retry_delay=0.0)
        messages = _make_messages()
        bad_json = '{"summary": "incomplete'

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = _make_response(bad_json, has_finish_reason=False)
            with pytest.raises(LLMParseError) as exc_info:
                await p._summarize_history(messages, summary_budget=500)
            assert "truncated" not in str(exc_info.value).lower()


# ---------------------------------------------------------------------------
# _summarize_history_incremental
# ---------------------------------------------------------------------------
class TestSummarizeHistoryIncremental:
    """Tests for _summarize_history_incremental condition branches."""

    @pytest.mark.asyncio
    async def test_success_within_budget(self):
        """JSON parses OK and tokens within budget → returns updated summary."""
        p = _make_participant()
        new_messages = _make_messages()
        updated_summary = "Updated meeting summary."
        response_content = json.dumps({"summary": updated_summary})

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = _make_response(response_content, "stop")
            result = await p._summarize_history_incremental(
                "Previous summary.", new_messages, summary_budget=500
            )

        assert result == updated_summary
        mock_llm.assert_called_once()

    @pytest.mark.asyncio
    async def test_tokens_over_budget_triggers_retry(self):
        """Tokens exceed budget on first try → retries, succeeds on second."""
        p = _make_participant(max_retries=2, retry_delay=0.0)
        new_messages = _make_messages()

        long_summary = "word " * 200
        short_summary = "Short update."

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.side_effect = [
                _make_response(json.dumps({"summary": long_summary}), "stop"),
                _make_response(json.dumps({"summary": short_summary}), "stop"),
            ]
            result = await p._summarize_history_incremental(
                "Previous summary.", new_messages, summary_budget=50
            )

        assert result == short_summary
        assert mock_llm.call_count == 2

    @pytest.mark.asyncio
    async def test_json_truncated_by_max_tokens(self):
        """JSON broken + finish_reason='length' → truncation error, retries."""
        p = _make_participant(max_retries=2, retry_delay=0.0)
        new_messages = _make_messages()

        truncated_json = '{"summary": "Truncated upd'
        valid_response = json.dumps({"summary": "Fixed update."})

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.side_effect = [
                _make_response(truncated_json, "length"),
                _make_response(valid_response, "stop"),
            ]
            result = await p._summarize_history_incremental(
                "Previous summary.", new_messages, summary_budget=500
            )

        assert result == "Fixed update."
        assert mock_llm.call_count == 2

    @pytest.mark.asyncio
    async def test_json_parse_error_not_truncated(self):
        """JSON broken + finish_reason='stop' → generic parse error, retries."""
        p = _make_participant(max_retries=2, retry_delay=0.0)
        new_messages = _make_messages()

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.side_effect = [
                _make_response("garbage output", "stop"),
                _make_response(json.dumps({"summary": "Recovered."}), "stop"),
            ]
            result = await p._summarize_history_incremental(
                "Previous summary.", new_messages, summary_budget=500
            )

        assert result == "Recovered."
        assert mock_llm.call_count == 2

    @pytest.mark.asyncio
    async def test_missing_finish_reason_attribute(self):
        """Response without finish_reason attr + broken JSON → generic parse error, not truncation."""
        p = _make_participant(max_retries=2, retry_delay=0.0)
        new_messages = _make_messages()

        bad_json = '{"summary": "incomplete'
        valid_response = json.dumps({"summary": "Recovered."})

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.side_effect = [
                _make_response(bad_json, has_finish_reason=False),
                _make_response(valid_response, "stop"),
            ]
            result = await p._summarize_history_incremental(
                "Previous summary.", new_messages, summary_budget=500
            )

        assert result == "Recovered."
        assert mock_llm.call_count == 2


# ---------------------------------------------------------------------------
# _apply_auto_compact (integration with summarize methods)
# ---------------------------------------------------------------------------
class TestApplyAutoCompact:
    """Tests for _apply_auto_compact dispatch and caching."""

    @pytest.mark.asyncio
    async def test_under_threshold_returns_original(self):
        """When raw tokens < threshold, history is returned unchanged."""
        p = _make_participant()
        msgs = _make_messages(2)

        # Large threshold so tokens will be under
        result = await p._apply_auto_compact(msgs, threshold_tokens=100000, target_tokens=50000)
        assert result == msgs

    @pytest.mark.asyncio
    async def test_initial_summarization_creates_cache(self):
        """First time over threshold → summarizes older msgs, creates cache."""
        p = _make_participant()
        msgs = _make_messages(10)

        summary_text = "Summary of early messages."
        response_content = json.dumps({"summary": summary_text})

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = _make_response(response_content, "stop")
            # threshold low enough to trigger, target low enough so not all msgs fit in recent
            result = await p._apply_auto_compact(
                msgs, threshold_tokens=10, target_tokens=30
            )

        # Cache should be set
        assert p._compact_cache_summary == summary_text
        assert p._compact_cache_older_count > 0
        # Result should contain HistorySummary + recent
        names = [getattr(m, "name", "") for m in result]
        assert "HistorySummary" in names

    @pytest.mark.asyncio
    async def test_cached_compacted_view_under_threshold(self):
        """Cache exists, compacted view under threshold → no LLM call."""
        p = _make_participant()
        p._compact_cache_summary = "Existing summary."
        p._compact_cache_older_count = 3

        msgs = _make_messages(5)

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            result = await p._apply_auto_compact(
                msgs, threshold_tokens=100000, target_tokens=50000
            )

        # No LLM call needed
        mock_llm.assert_not_called()
        # Result should have summary message
        names = [getattr(m, "name", "") for m in result]
        assert "HistorySummary" in names

    @pytest.mark.asyncio
    async def test_stale_cache_is_cleared_when_history_resets(self):
        """If cached split is incompatible with current history, cache is dropped."""
        p = _make_participant()
        p._compact_cache_summary = "stale"
        p._compact_cache_older_count = 999
        msgs = _make_messages(5)

        with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
            result = await p._apply_auto_compact(
                msgs, threshold_tokens=100000, target_tokens=50000
            )

        mock_llm.assert_not_called()
        assert result == msgs
        assert p._compact_cache_summary is None
        assert p._compact_cache_older_count == 0


class TestContextManagementSafety:
    """Safety checks for context management edge cases."""

    @pytest.mark.asyncio
    async def test_apply_context_management_without_max_context_length_attr(self):
        """Missing llm.max_context_length should not raise."""
        class LLMNoContext:
            pass

        llm = LLMNoContext()
        p = Participant(
            llm=llm,
            name="TestAgent",
            background="A test participant",
            personality="Curious",
            preferences="Efficient discussions",
            personal_goals="Testing",
        )
        msgs = _make_messages(3)
        result = await p._apply_context_management(msgs)
        assert result == msgs

    async def test_meeting_reset_clears_participant_context_cache(self):
        """Meeting.reset() should clear participant auto_compact cache."""
        meeting = AITourMeeting()
        p = _make_participant()
        p._compact_cache_summary = "old summary"
        p._compact_cache_older_count = 5
        meeting.add_participant(p)

        meeting.reset()

        assert p._compact_cache_summary is None
        assert p._compact_cache_older_count == 0


# ---------------------------------------------------------------------------
# Integration tests (require running vLLM)
# ---------------------------------------------------------------------------
@pytest.mark.skipif(not _vllm_available(), reason="vLLM not available")
class TestVLLMIntegration:
    """Integration tests against a real vLLM instance to verify response structure."""

    @pytest.mark.asyncio
    async def test_finish_reason_exists_normal(self):
        """Normal completion should have finish_reason='stop'."""
        response = await litellm.acompletion(
            model=VLLM_MODEL,
            api_base=VLLM_BASE,
            api_key=VLLM_API_KEY,
            messages=[{"role": "user", "content": "Say hello in one word. /no_think"}],
            max_tokens=256,
        )
        choice = response.choices[0]
        assert hasattr(choice, "finish_reason"), \
            f"Response choice missing 'finish_reason'. Attrs: {dir(choice)}"
        assert choice.finish_reason == "stop", \
            f"Expected finish_reason='stop', got '{choice.finish_reason}'"

    @pytest.mark.asyncio
    async def test_finish_reason_length_on_truncation(self):
        """When max_tokens is hit, finish_reason should be 'length'."""
        response = await litellm.acompletion(
            model=VLLM_MODEL,
            api_base=VLLM_BASE,
            api_key=VLLM_API_KEY,
            messages=[{"role": "user", "content": "Write a very long story about a dragon."}],
            max_tokens=5,  # Force truncation
        )
        choice = response.choices[0]
        assert hasattr(choice, "finish_reason"), \
            f"Response choice missing 'finish_reason'. Attrs: {dir(choice)}"
        assert choice.finish_reason == "length", \
            f"Expected finish_reason='length', got '{choice.finish_reason}'"

    @pytest.mark.asyncio
    async def test_response_has_usage(self):
        """Response should have usage with prompt_tokens and completion_tokens."""
        response = await litellm.acompletion(
            model=VLLM_MODEL,
            api_base=VLLM_BASE,
            api_key=VLLM_API_KEY,
            messages=[{"role": "user", "content": "Say hi."}],
            max_tokens=16,
        )
        assert hasattr(response, "usage"), "Response missing 'usage'"
        assert response.usage.prompt_tokens > 0, "prompt_tokens should be > 0"
        assert response.usage.completion_tokens > 0, "completion_tokens should be > 0"

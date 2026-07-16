"""Tests for search_engine module (LiteLLM-based implementation)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from tour_meeting.search_engine import (
    SEARCH_PROMPT_VERSION,
    SEARCH_SYSTEM_INSTRUCTIONS,
    _create_response,
    _dedupe_preserve_order,
    _extract_search_text,
    _flatten_response_text,
    gpt5_search_sync,
)


class TestFlattenResponseText:
    def test_extracts_output_text(self):
        response = MagicMock()
        response.output_text = "  Hello  "
        assert _flatten_response_text(response) == "Hello"

    def test_returns_empty_on_non_string(self):
        response = MagicMock()
        response.output_text = 123
        assert _flatten_response_text(response) == ""


class TestExtractSearchText:
    def test_skips_web_search_call_blocks(self):
        entry = {"type": "web_search_call", "text": "ignored"}
        assert _extract_search_text(entry) == []

    def test_extracts_nested_content(self):
        entry = {"content": [{"text": "A"}, {"message": "B"}, "C"]}
        result = _extract_search_text(entry)
        assert result == ["A", "B", "C"]

    def test_extracts_sequences(self):
        entry = ["x", ["y"], {"text": "z"}]
        assert _extract_search_text(entry) == ["x", "y", "z"]


class TestDedupePreserveOrder:
    def test_dedupes_and_preserves_order(self):
        items = ["a", "b", "a", "c", "b"]
        assert _dedupe_preserve_order(items) == ["a", "b", "c"]

    def test_drops_empty(self):
        items = ["", " ", "a", "  a  ", "b"]
        assert _dedupe_preserve_order(items) == ["a", "b"]


class TestCreateResponse:
    def test_uses_litellm_responses_create_if_available(self):
        with patch("tour_meeting.search_engine.litellm") as mock_litellm:
            creator = MagicMock(return_value={"ok": True})
            mock_litellm.responses = MagicMock()
            mock_litellm.responses.create = creator
            out = _create_response({"model": "x"})
            assert out == {"ok": True}
            creator.assert_called_once_with(model="x")

    def test_falls_back_to_litellm_response(self):
        with patch("tour_meeting.search_engine.litellm") as mock_litellm:
            mock_litellm.responses = None
            mock_litellm.response = MagicMock(return_value={"ok": "fallback"})
            out = _create_response({"model": "x"})
            assert out == {"ok": "fallback"}
            mock_litellm.response.assert_called_once_with(model="x")

    def test_raises_if_no_responses_api(self):
        with patch("tour_meeting.search_engine.litellm") as mock_litellm:
            mock_litellm.responses = None
            mock_litellm.response = None
            try:
                _create_response({"model": "x"})
                raise AssertionError("Expected RuntimeError")
            except RuntimeError as exc:
                assert "LiteLLM responses API" in str(exc)


class TestGpt5SearchSync:
    def test_empty_query_returns_skip_message(self):
        assert gpt5_search_sync("   ") == "Search skipped: empty query."

    def test_uses_input_for_nano_models(self):
        response = MagicMock()
        response.output_text = "result"
        response.output = []
        with patch("tour_meeting.search_engine._create_response", return_value=response) as mock_create:
            gpt5_search_sync(
                "query",
                model="gpt-5-nano-2025-08-07",
                messages=[{"role": "user", "content": "prev"}],
            )
            call_kwargs = mock_create.call_args[0][0]
            assert call_kwargs["input"] == "query"
            assert "messages" not in call_kwargs
            assert call_kwargs["instructions"] == SEARCH_SYSTEM_INSTRUCTIONS
            assert call_kwargs["user"] == SEARCH_PROMPT_VERSION

    def test_uses_messages_for_non_nano_models(self):
        response = MagicMock()
        response.output_text = "result"
        response.output = []
        with patch("tour_meeting.search_engine._create_response", return_value=response) as mock_create:
            gpt5_search_sync(
                "new",
                model="gpt-5-mini-2025-08-07",
                messages=[{"role": "user", "content": "prev"}],
            )
            call_kwargs = mock_create.call_args[0][0]
            assert "messages" in call_kwargs
            assert call_kwargs["messages"][-1] == {"role": "user", "content": "new"}
            assert "input" not in call_kwargs

    def test_formats_response_with_header_and_deduped_lines(self):
        response = MagicMock()
        response.output_text = "alpha"
        response.output = [
            {"text": "alpha"},  # duplicate
            {"message": "beta"},
            {"content": [{"text": "gamma"}]},
        ]
        with patch("tour_meeting.search_engine._create_response", return_value=response):
            out = gpt5_search_sync("k")
            assert out.startswith("gpt-5 search results for 'k':")
            # Keep unique lines only.
            assert "\nalpha\nbeta\ngamma" in out

    def test_returns_error_text_on_exception(self):
        with patch("tour_meeting.search_engine._create_response", side_effect=RuntimeError("boom")):
            out = gpt5_search_sync("k")
            assert "gpt-5 search error" in out
            assert "boom" in out


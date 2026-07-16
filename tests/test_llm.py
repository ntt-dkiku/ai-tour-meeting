"""Tests for llm module."""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

from tour_meeting.llm import (
    get_env_key_name,
    verify_api_key,
    check_existing_key,
    verify_model_name,
    list_ollama_models,
)


class TestGetEnvKeyName:
    """Tests for get_env_key_name function."""

    def test_openai_provider(self):
        """OpenAI provider returns OPENAI_API_KEY."""
        assert get_env_key_name("openai") == "OPENAI_API_KEY"

    def test_google_provider(self):
        """Google provider returns GOOGLE_API_KEY."""
        assert get_env_key_name("google") == "GOOGLE_API_KEY"

    def test_anthropic_provider(self):
        """Anthropic provider returns ANTHROPIC_API_KEY."""
        assert get_env_key_name("anthropic") == "ANTHROPIC_API_KEY"

    def test_unknown_provider(self):
        """Unknown provider returns default API_KEY."""
        assert get_env_key_name("unknown") == "API_KEY"

    def test_empty_provider(self):
        """Empty provider returns default API_KEY."""
        assert get_env_key_name("") == "API_KEY"


class TestVerifyApiKey:
    """Tests for verify_api_key function."""

    def test_empty_api_key_returns_false(self):
        """Empty API key returns False immediately."""
        assert verify_api_key("openai", "") is False
        assert verify_api_key("anthropic", "") is False
        assert verify_api_key("google", "") is False

    def test_none_api_key_returns_false(self):
        """None API key returns False."""
        assert verify_api_key("openai", None) is False

    def test_openai_valid_key(self):
        """Valid OpenAI key returns True."""
        with patch("tour_meeting.llm.openai.OpenAI") as mock_openai:
            mock_client = MagicMock()
            mock_client.models.list.return_value = []
            mock_openai.return_value = mock_client

            result = verify_api_key("openai", "sk-valid-key")

            assert result is True
            mock_openai.assert_called_once_with(api_key="sk-valid-key")

    def test_openai_invalid_key(self):
        """Invalid OpenAI key returns False."""
        import openai

        with patch("tour_meeting.llm.openai.OpenAI") as mock_openai:
            mock_client = MagicMock()
            mock_client.models.list.side_effect = openai.AuthenticationError(
                message="Invalid API key",
                response=MagicMock(),
                body=None
            )
            mock_openai.return_value = mock_client

            result = verify_api_key("openai", "sk-invalid-key")

            assert result is False

    def test_anthropic_valid_key(self):
        """Valid Anthropic key returns True (status 200)."""
        with patch("tour_meeting.llm.requests.get") as mock_get:
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_get.return_value = mock_response

            result = verify_api_key("anthropic", "sk-ant-valid")

            assert result is True
            mock_get.assert_called_once()
            call_kwargs = mock_get.call_args
            assert "x-api-key" in call_kwargs[1]["headers"]

    def test_anthropic_invalid_key(self):
        """Invalid Anthropic key returns False (status 401)."""
        with patch("tour_meeting.llm.requests.get") as mock_get:
            mock_response = MagicMock()
            mock_response.status_code = 401
            mock_get.return_value = mock_response

            result = verify_api_key("anthropic", "sk-ant-invalid")

            assert result is False

    def test_google_valid_key(self):
        """Valid Google key returns True (status 200)."""
        with patch("tour_meeting.llm.requests.get") as mock_get:
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_get.return_value = mock_response

            result = verify_api_key("google", "google-valid-key")

            assert result is True

    def test_google_invalid_key(self):
        """Invalid Google key returns False (status 400)."""
        with patch("tour_meeting.llm.requests.get") as mock_get:
            mock_response = MagicMock()
            mock_response.status_code = 400
            mock_get.return_value = mock_response

            result = verify_api_key("google", "google-invalid-key")

            assert result is False

    def test_unknown_provider_returns_false(self):
        """Unknown provider returns False."""
        result = verify_api_key("unknown", "some-key")
        assert result is False

    def test_exception_returns_false(self):
        """Exception during verification returns False."""
        with patch("tour_meeting.llm.openai.OpenAI") as mock_openai:
            mock_openai.side_effect = Exception("Network error")

            result = verify_api_key("openai", "sk-some-key")

            assert result is False


class TestCheckExistingKey:
    """Tests for check_existing_key function."""

    def test_no_env_key_returns_false(self):
        """Missing environment variable returns False."""
        original = os.environ.get("OPENAI_API_KEY")
        try:
            if "OPENAI_API_KEY" in os.environ:
                del os.environ["OPENAI_API_KEY"]

            result = check_existing_key("openai")

            assert result is False
        finally:
            if original is not None:
                os.environ["OPENAI_API_KEY"] = original

    def test_env_key_exists_but_invalid(self):
        """Environment variable exists but key is invalid returns False."""
        original = os.environ.get("OPENAI_API_KEY")
        try:
            os.environ["OPENAI_API_KEY"] = "invalid-key"

            with patch("tour_meeting.llm.verify_api_key") as mock_verify:
                mock_verify.return_value = False

                result = check_existing_key("openai")

                assert result is False
                mock_verify.assert_called_once_with("openai", "invalid-key")
        finally:
            if original is not None:
                os.environ["OPENAI_API_KEY"] = original
            elif "OPENAI_API_KEY" in os.environ:
                del os.environ["OPENAI_API_KEY"]

    def test_env_key_exists_and_valid(self):
        """Environment variable exists and key is valid returns True."""
        original = os.environ.get("OPENAI_API_KEY")
        try:
            os.environ["OPENAI_API_KEY"] = "valid-key"

            with patch("tour_meeting.llm.verify_api_key") as mock_verify:
                mock_verify.return_value = True

                result = check_existing_key("openai")

                assert result is True
        finally:
            if original is not None:
                os.environ["OPENAI_API_KEY"] = original
            elif "OPENAI_API_KEY" in os.environ:
                del os.environ["OPENAI_API_KEY"]


class TestVerifyModelName:
    """Tests for verify_model_name function."""

    def test_model_exists(self):
        """Model exists in Ollama returns True."""
        with patch("tour_meeting.llm.requests.get") as mock_get:
            mock_response = MagicMock()
            mock_response.json.return_value = {
                "models": [
                    {"name": "llama3"},
                    {"name": "mistral"}
                ]
            }
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response

            result = verify_model_name("llama3")

            assert result is True

    def test_model_not_exists(self):
        """Model does not exist in Ollama returns False."""
        with patch("tour_meeting.llm.requests.get") as mock_get:
            mock_response = MagicMock()
            mock_response.json.return_value = {
                "models": [
                    {"name": "llama3"}
                ]
            }
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response

            result = verify_model_name("nonexistent-model")

            assert result is False

    def test_custom_base_url(self):
        """Custom base_url is used correctly."""
        with patch("tour_meeting.llm.requests.get") as mock_get:
            mock_response = MagicMock()
            mock_response.json.return_value = {"models": []}
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response

            verify_model_name("model", base_url="http://custom:11434")

            mock_get.assert_called_once_with("http://custom:11434/api/tags")

    def test_default_base_url(self):
        """Default localhost URL is used when base_url is None."""
        with patch("tour_meeting.llm.requests.get") as mock_get:
            mock_response = MagicMock()
            mock_response.json.return_value = {"models": []}
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response

            verify_model_name("model")

            mock_get.assert_called_once_with("http://localhost:11434/api/tags")


class TestListOllamaModels:
    """Tests for list_ollama_models function."""

    def test_returns_models_list(self):
        """Returns list of models on success."""
        with patch("tour_meeting.llm.requests.get") as mock_get:
            mock_response = MagicMock()
            mock_response.json.return_value = {
                "models": [
                    {"name": "llama3", "size": 1000},
                    {"name": "mistral", "size": 2000}
                ]
            }
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response

            result = list_ollama_models()

            assert len(result) == 2
            assert result[0]["name"] == "llama3"

    def test_returns_empty_list_on_error(self):
        """Returns empty list on exception."""
        with patch("tour_meeting.llm.requests.get") as mock_get:
            mock_get.side_effect = Exception("Connection error")

            result = list_ollama_models()

            assert result == []

    def test_custom_base_url(self):
        """Custom base_url is used correctly."""
        with patch("tour_meeting.llm.requests.get") as mock_get:
            mock_response = MagicMock()
            mock_response.json.return_value = {"models": []}
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response

            list_ollama_models(base_url="http://custom:11434")

            mock_get.assert_called_once_with("http://custom:11434/api/tags")


class TestExtractJson:
    """Tests for extract_json — the last JSON candidate in the text must win,
    so reasoning-style drafts written mid-thought don't get picked up."""

    def test_plain_json(self):
        from tour_meeting.llm import extract_json
        assert extract_json('{"message": "ok"}') == {"message": "ok"}

    def test_fenced_json(self):
        from tour_meeting.llm import extract_json
        assert extract_json('```json\n{"message": "fenced"}\n```') == {"message": "fenced"}

    def test_json_with_trailing_prose(self):
        from tour_meeting.llm import extract_json
        text = '{"message": "Sounds great!"}\n\nLet me also add that...'
        assert extract_json(text) == {"message": "Sounds great!"}

    def test_last_json_wins_over_draft_in_code_block(self):
        from tour_meeting.llm import extract_json
        text = (
            "Thinking Process:\n"
            'Draft: ```json\n{"message": "I want to see..."}\n```\n'
            "Refine it.\n\n"
            '{"message": "The full, final answer."}'
        )
        assert extract_json(text) == {"message": "The full, final answer."}

    def test_last_json_wins_over_earlier_bare_object(self):
        from tour_meeting.llm import extract_json
        text = 'maybe {"action": "ask"} no wait.\n{"action": "propose", "message": "Route."}'
        assert extract_json(text) == {"action": "propose", "message": "Route."}

    def test_braces_inside_string_values(self):
        from tour_meeting.llm import extract_json
        assert extract_json('{"message": "use {curly} :}"}') == {"message": "use {curly} :}"}

    def test_think_block_stripped(self):
        from tour_meeting.llm import extract_json
        text = '<think>{"message": "draft"}</think>{"message": "real"}'
        assert extract_json(text) == {"message": "real"}

    def test_invalid_trailing_json_falls_back_to_earlier_valid(self):
        from tour_meeting.llm import extract_json
        text = '{"message": "complete"}\nand then {"message": "cut off'
        assert extract_json(text) == {"message": "complete"}

    def test_no_json_raises(self):
        from tour_meeting.llm import extract_json
        import pytest
        with pytest.raises(ValueError):
            extract_json("no json here at all")

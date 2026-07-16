import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tour_meeting.llm import LLMConfig
from tour_meeting.messages import HumanMessage
from tour_meeting.participant import LLMParseError, Participant


pytestmark = pytest.mark.asyncio(loop_scope="function")


def _make_participant(**kwargs) -> Participant:
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
        retry_delay=kwargs.pop("retry_delay", 0.0),
        **kwargs,
    )


def _make_response(content: str):
    choice = MagicMock(spec=["message"])
    choice.message = MagicMock()
    choice.message.content = content

    usage = MagicMock()
    usage.prompt_tokens = 10
    usage.completion_tokens = 5
    usage.total_tokens = 15

    response = MagicMock()
    response.choices = [choice]
    response.usage = usage
    return response


def _dummy_tracker():
    return SimpleNamespace(
        token_usage=SimpleNamespace(
            input_tokens=1, output_tokens=1, total_tokens=2, cached_tokens=0
        )
    )


async def test_retry_with_backoff_passes_failed_output_and_feedback_to_next_attempt():
    participant = _make_participant(max_retries=2, retry_delay=0.0)
    seen_contexts = []

    async def _op(error_context):
        seen_contexts.append(list(error_context))
        if len(seen_contexts) == 1:
            raise LLMParseError(
                "bad parse",
                raw_output='{"action":"scoring","message":"ok","score":null}',
            )
        return {"ok": True}, _dummy_tracker()

    result = await participant._retry_with_backoff(
        operation_name="unit_test",
        operation_func=_op,
        format_instructions="FORMAT-INSTR",
    )

    assert result == {"ok": True}
    assert seen_contexts[0] == []
    assert len(seen_contexts[1]) == 2
    assert seen_contexts[1][0]["role"] == "assistant"
    assert '"score":null' in seen_contexts[1][0]["content"]
    assert seen_contexts[1][1]["role"] == "user"
    assert "Your output could not be parsed." in seen_contexts[1][1]["content"]
    assert "FORMAT-INSTR" in seen_contexts[1][1]["content"]


async def test_vote_route_retries_when_scoring_score_is_none():
    participant = _make_participant(max_retries=2, retry_delay=0.0, max_steps=1)
    history = [HumanMessage(content="meeting goal", name="MeetingGoal")]

    first = json.dumps(
        {
            "action": "scoring",
            "message": "I'll score this now.",
            "score": None,
        }
    )
    second = json.dumps(
        {
            "action": "scoring",
            "message": "Final score is 8.",
            "score": 8,
        }
    )

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = [_make_response(first), _make_response(second)]
        result = await participant.vote_route(
            other_participant_names=[],
            history=history,
            proposer_name="Proposer",
            proposed_route_text="Route proposal",
            current_route_text="Current route",
            current_route_score="Current score",
            voting_rule="most_pleasure",
            allow_search=False,
            max_steps=1,
        )

    assert mock_llm.call_count == 2
    assert result["score"] == 8
    assert result["accept"] is True


async def test_free_turn_retries_when_search_query_is_missing():
    participant = _make_participant(max_retries=2, retry_delay=0.0, max_steps=1)
    history = [HumanMessage(content="meeting goal", name="MeetingGoal")]

    first = json.dumps(
        {
            "action": "search",
            "message": "Let me quickly search that.",
            "query": None,
        }
    )
    second = json.dumps(
        {
            "action": "satisfied",
            "message": "I think we can proceed with the current plan.",
        }
    )

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = [_make_response(first), _make_response(second)]
        result = await participant.free_turn(
            other_participant_names=[],
            history=history,
            current_route=None,
            current_route_destinations=None,
            current_route_text="Current route",
            allow_search=True,
            max_steps=1,
        )

    assert mock_llm.call_count == 2
    assert result["conclusion"] == "continue"

"""Tests for the human participant's LLM-like action loops.

The human's speaking turn is a multi-step loop (ask → speak/propose/satisfied)
and the voting turn is a multi-step loop (ask → judge), mirroring the LLM
participants. These tests drive those loops by feeding action dicts through the
meeting's submit_* methods as the corresponding events surface.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tour_meeting.cli import build_meeting
from tour_meeting.types import (
    HumanTurn,
    HumanVote,
    TurnFinal,
    ProposalVoteResult,
    SatisfiedUpdate,
)

pytestmark = pytest.mark.asyncio(loop_scope="function")

RUN_TIMEOUT = 10.0


def _participant(name: str, max_steps: int = 3) -> Dict[str, Any]:
    return {
        "name": name,
        "model_name": "test/mock",
        "background": f"{name} is a test participant.",
        "personality": "Curious.",
        "preferences": "Efficient discussions.",
        "personal_goals": "Test goals.",
        "role": "attendee",
        "temperature": 0.0,
        "max_steps": max_steps,
        "web_search": False,
    }


def _make_llm_response(content: str):
    choice = MagicMock()
    choice.message = MagicMock()
    choice.message.content = content
    choice.finish_reason = "stop"
    usage = MagicMock()
    usage.prompt_tokens = 10
    usage.completion_tokens = 5
    usage.total_tokens = 15
    response = MagicMock()
    response.choices = [choice]
    response.usage = usage
    return response


def _side_effect(responses: List[str]):
    idx = 0

    async def se(*args, **kwargs):
        nonlocal idx
        content = responses[idx] if idx < len(responses) else json.dumps(
            {"action": "satisfied", "message": "done"}
        )
        idx += 1
        return _make_llm_response(content)

    return se


_ROUTE_JSON = [
    {
        "name": "Museum",
        "description": "A nice museum",
        "transport_mode": "walk",
        "transport_cost": "$0",
        "travel_time_from_previous": "10 min",
        "start_time": "10:00",
        "stay_duration": "60 min",
        "cost": "$10",
    },
    {
        "name": "Park",
        "description": "A quiet park",
        "transport_mode": "walk",
        "transport_cost": "$0",
        "travel_time_from_previous": "15 min",
        "start_time": "11:15",
        "stay_duration": "45 min",
        "cost": "$0",
    },
]


def _build_meeting(order: List[str], max_steps: int = 3):
    meeting = build_meeting(
        title="Human Actions",
        global_goals="Plan a test tour.",
        participants=[_participant("P0", max_steps=max_steps)],
        settings={
            "turn_rule": "round_robin",
            "voting_rule": "majority",
            "max_turns": 10,
            "balanced_turns": True,
        },
    )
    meeting.enable_human(name="You")
    meeting.set_order(order)
    return meeting


async def test_human_speaking_turn_exposes_step_and_candidates():
    """The human's speaking turn surfaces step/max_steps and askable names."""
    meeting = _build_meeting(["__YOU__", "P0"], max_steps=3)

    seen: List[HumanTurn] = []

    async def drive():
        async for event in meeting.run_free_conversation():
            if isinstance(event, HumanTurn):
                seen.append(event)
                meeting.submit_human({"action": "speak", "message": "Hi all."})
            if isinstance(event, TurnFinal) and event.speaker == "You":
                break

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect([])
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    assert seen, "a HumanTurn prompt should be emitted"
    first = seen[0]
    assert first.max_steps == 3  # matches the single participant's max_steps
    assert first.step == 1
    assert first.candidates == ["P0"]  # askable LLM participant


async def test_human_speak_records_message():
    meeting = _build_meeting(["__YOU__", "P0"])
    final = None

    async def drive():
        nonlocal final
        async for event in meeting.run_free_conversation():
            if isinstance(event, HumanTurn):
                meeting.submit_human({"action": "speak", "message": "My opinion."})
            if isinstance(event, TurnFinal) and event.speaker == "You":
                final = event
                break

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect([])
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    assert final is not None
    assert final.text == "My opinion."


async def test_human_ask_then_speak_within_one_turn():
    """The human asks an LLM (intermediate) then speaks (final) in one turn."""
    meeting = _build_meeting(["__YOU__", "P0"], max_steps=3)
    responses = [json.dumps({"message": "My budget is flexible."})]  # P0.answer_question

    asked = False
    final = None

    async def drive():
        nonlocal asked, final
        async for event in meeting.run_free_conversation():
            if isinstance(event, HumanTurn):
                if not asked:
                    asked = True
                    meeting.submit_human({"action": "ask", "target": "P0", "message": "What's your budget?"})
                else:
                    meeting.submit_human({"action": "speak", "message": "Thanks."})
            elif isinstance(event, TurnFinal) and event.speaker == "You":
                final = event
                break

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect(responses)
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    # The ask renders inline as an "ask" step: the question and the target's
    # answer land in the turn's steps_log (mirroring an LLM participant).
    assert final is not None
    assert final.text == "Thanks."
    assert final.steps_log is not None
    assert "What's your budget?" in final.steps_log
    assert "Ask: P0" in final.steps_log
    assert "AskA: My budget is flexible." in final.steps_log


async def test_human_satisfied_after_accepted_route_reaches_consensus():
    """A human 'satisfied' when a route is accepted and the LLM is satisfied
    drives the meeting to consensus."""
    meeting = _build_meeting(["P0", "__YOU__"], max_steps=2)
    # P0 proposes a route, human accepts it, P0 satisfied, human satisfied.
    responses = [
        json.dumps({"action": "propose", "message": "How about this route?"}),
        json.dumps({"message": "Here's the route.", "route": _ROUTE_JSON}),
        json.dumps({"action": "satisfied", "message": "Looks great."}),
    ]

    finished_consensus = False

    async def drive():
        nonlocal finished_consensus
        async for event in meeting.run_free_conversation():
            if isinstance(event, HumanVote):
                meeting.submit_human_vote({"action": "judge", "accept": True, "message": "I accept."})
            elif isinstance(event, HumanTurn):
                meeting.submit_human({"action": "satisfied", "message": "I'm happy."})
        summary = meeting.analytics.get_summary()
        finished_consensus = summary.get("termination_reason") == "consensus"

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect(responses)
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    assert finished_consensus, "human satisfied + accepted route should reach consensus"


def _human_history_contents(meeting) -> List[str]:
    return [
        m.content
        for m in meeting.history
        if getattr(m, "name", "") == "You" and isinstance(m.content, str)
    ]


async def test_human_satisfied_turn_carries_satisfied_label():
    """The human's satisfied turn tags its TurnFinal with the 'satisfied' label
    (GUI badge) AND encodes the action in the history content the other LLMs
    read — a "[Step N/M - satisfied]" line like an LLM turn, not just metadata."""
    meeting = _build_meeting(["__YOU__", "P0"], max_steps=3)
    final = None

    async def drive():
        nonlocal final
        saw_final = False
        async for event in meeting.run_free_conversation():
            if isinstance(event, HumanTurn):
                meeting.submit_human({"action": "satisfied", "message": "I'm happy."})
            if isinstance(event, TurnFinal) and event.speaker == "You":
                final = event
                saw_final = True
                continue
            # Break one event later so the history append (which runs after the
            # TurnFinal yield) has executed and can be inspected.
            if saw_final:
                break

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect([])
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    assert final is not None, "the human's satisfied turn should emit a TurnFinal"
    assert final.steps_label == "satisfied"
    assert final.text == "I'm happy."  # clean text drives the GUI (badge + comment)

    # The other participants read the satisfied action in the message content.
    contents = _human_history_contents(meeting)
    assert contents, "the human's turn should be recorded in history"
    content = contents[-1]
    assert "[Step" in content and "satisfied]" in content
    assert "I'm happy." in content


async def test_human_satisfied_without_comment_has_empty_text():
    """Satisfied with no comment: the GUI text is empty (badge only), but the
    history content still carries the bare "[Step N/M - satisfied]" marker so
    the other LLMs see the agreement — no placeholder prose."""
    meeting = _build_meeting(["__YOU__", "P0"], max_steps=3)
    final = None

    async def drive():
        nonlocal final
        saw_final = False
        async for event in meeting.run_free_conversation():
            if isinstance(event, HumanTurn):
                meeting.submit_human({"action": "satisfied", "message": ""})
            if isinstance(event, TurnFinal) and event.speaker == "You":
                final = event
                saw_final = True
                continue
            if saw_final:
                break

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect([])
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    assert final is not None
    assert final.steps_label == "satisfied"
    assert final.text == ""

    contents = _human_history_contents(meeting)
    assert contents, "the human's turn should be recorded in history"
    content = contents[-1]
    assert "satisfied]" in content
    assert "agrees to conclude" not in content  # no placeholder prose


async def test_human_turn_carries_accepted_route_as_base():
    """Once a route is accepted, the human's turn prompt carries it (as the
    seed for the propose editor)."""
    meeting = _build_meeting(["P0", "__YOU__"], max_steps=2)
    # P0 proposes the two-stop route; the human accepts it in the vote.
    responses = [
        json.dumps({"action": "propose", "message": "How about this route?"}),
        json.dumps({"message": "Here's the route.", "route": _ROUTE_JSON}),
    ]
    human_turns: List[HumanTurn] = []

    async def drive():
        async for event in meeting.run_free_conversation():
            if isinstance(event, HumanVote):
                meeting.submit_human_vote({"action": "judge", "accept": True, "message": "ok"})
            elif isinstance(event, HumanTurn):
                human_turns.append(event)
                break

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect(responses)
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    assert human_turns, "the human should get a speaking turn after voting"
    names = [d.get("name") for d in human_turns[0].current_route]
    assert names == ["Museum", "Park"]


async def test_human_turn_without_accepted_route_has_empty_base():
    """With no accepted route yet, the human's turn carries an empty base."""
    meeting = _build_meeting(["__YOU__", "P0"], max_steps=2)
    human_turns: List[HumanTurn] = []

    async def drive():
        async for event in meeting.run_free_conversation():
            if isinstance(event, HumanTurn):
                human_turns.append(event)
                break

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect([])
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    assert human_turns
    assert human_turns[0].current_route == []


async def test_human_propose_triggers_voting_with_human_route():
    """A human proposal (route from the editor) goes to a vote by the LLMs."""
    meeting = _build_meeting(["__YOU__", "P0"], max_steps=2)
    responses = [json.dumps({"action": "accept", "message": "P0 accepts."})]  # P0 votes

    vote_result = None

    async def drive():
        nonlocal vote_result
        async for event in meeting.run_free_conversation():
            if isinstance(event, HumanTurn):
                meeting.submit_human({
                    "action": "propose",
                    "message": "My hand-built route.",
                    "route": _ROUTE_JSON,
                })
            elif isinstance(event, ProposalVoteResult):
                vote_result = event
                break

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect(responses)
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    assert vote_result is not None, "the human's proposal should be voted on"
    assert vote_result.proposer == "You"
    assert vote_result.accepted is True
    # The human proposer must not vote on their own proposal.
    voters = {v["participant"] for v in vote_result.vote_summary["votes"]}
    assert "You" not in voters
    assert voters == {"P0"}


async def test_human_vote_ask_then_judge():
    """During voting the human can ask an LLM, then judge with accept/reject."""
    meeting = _build_meeting(["P0", "__YOU__"], max_steps=3)
    responses = [
        json.dumps({"action": "propose", "message": "Proposing."}),
        json.dumps({"message": "Here's the route.", "route": _ROUTE_JSON}),
        json.dumps({"message": "It fits the budget."}),  # P0.answer_question during the human's vote
    ]

    human_vote_final = None
    vote_result = None
    asked = False

    async def drive():
        nonlocal human_vote_final, vote_result, asked
        async for event in meeting.run_free_conversation():
            if isinstance(event, HumanVote):
                if not asked:
                    asked = True
                    meeting.submit_human_vote({"action": "ask", "target": "P0", "message": "Does this fit the budget?"})
                else:
                    meeting.submit_human_vote({"action": "judge", "accept": True, "message": "Good enough."})
            elif isinstance(event, TurnFinal) and event.speaker == "You":
                human_vote_final = event
            elif isinstance(event, ProposalVoteResult):
                vote_result = event
                break

    with patch("tour_meeting.participant.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect(responses)
        await asyncio.wait_for(drive(), timeout=RUN_TIMEOUT)

    # The vote-time ask threads under the proposal like an LLM voter's: it lands
    # in the vote's steps_log, and the vote itself carries the verdict label.
    assert human_vote_final is not None, "the human's vote should emit a TurnFinal"
    assert human_vote_final.steps_log is not None
    assert "AskA: It fits the budget." in human_vote_final.steps_log
    assert human_vote_final.steps_label == "accept"
    assert vote_result is not None
    votes = {v["participant"]: v["accept"] for v in vote_result.vote_summary["votes"]}
    assert votes.get("You") is True


async def test_draft_route_for_human_runs_on_neutral_prompt():
    """draft_route_for_human turns a description into a RouteDraft on a
    neutral assistant system prompt (no participant persona)."""
    from tour_meeting.generate_with_ai import SYS_ROUTE_DRAFT, draft_route_for_human

    meeting = _build_meeting(["__YOU__", "P0"])
    llm = meeting.participants[0].llm
    response = json.dumps({"message": "A relaxed day.", "route": _ROUTE_JSON})

    with patch("tour_meeting.generate_with_ai.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect([response])
        draft = await asyncio.wait_for(
            draft_route_for_human(
                llm=llm,
                description="A relaxed cultural day.",
                meeting_goal="Plan a test tour.",
            ),
            timeout=RUN_TIMEOUT,
        )

    assert draft.message == "A relaxed day."
    assert [d.name for d in draft.route] == ["Museum", "Park"]
    # The system prompt is the neutral drafting one, not the participant's
    # persona prompt, and it carries the meeting goal.
    messages = mock_llm.await_args.kwargs["messages"]
    assert messages[0]["role"] == "system"
    assert SYS_ROUTE_DRAFT.splitlines()[0] in messages[0]["content"]
    assert "Plan a test tour." in messages[0]["content"]


async def test_draft_route_prompt_carries_every_partial_route_field():
    """The in-progress route reaches the LLM with ALL destination fields
    (transport/cost/travel time included) so unchanged values can be copied
    verbatim instead of being reinvented on every chat message."""
    from tour_meeting.generate_with_ai import draft_route_for_human

    meeting = _build_meeting(["__YOU__", "P0"])
    llm = meeting.participants[0].llm
    response = json.dumps({"message": "Tweaked.", "route": _ROUTE_JSON})
    partial = [
        {
            "name": "Museum",
            "description": "Modern art",
            "transport_mode": "bus",
            "transport_cost": "¥230",
            "travel_time_from_previous": "15 min",
            "start_time": "10:00",
            "stay_duration": "60 min",
            "cost": "¥1,500",
        }
    ]

    with patch("tour_meeting.generate_with_ai.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect([response])
        await asyncio.wait_for(
            draft_route_for_human(
                llm=llm,
                description="Rename the museum stop.",
                partial_route=partial,
            ),
            timeout=RUN_TIMEOUT,
        )

    user_message = mock_llm.await_args.kwargs["messages"][1]["content"]
    for value in ["bus", "¥230", "15 min", "10:00", "60 min", "¥1,500", "Modern art"]:
        assert value in user_message


async def test_draft_route_carries_dialog_history_as_conversation():
    """The refine dialog's prior chat is inserted between the system prompt and
    the current request, with the "ai" role mapped to assistant."""
    from tour_meeting.generate_with_ai import draft_route_for_human

    meeting = _build_meeting(["__YOU__", "P0"])
    llm = meeting.participants[0].llm
    response = json.dumps({"message": "Done.", "route": _ROUTE_JSON})

    with patch("tour_meeting.generate_with_ai.litellm.acompletion", new_callable=AsyncMock) as mock_llm:
        mock_llm.side_effect = _side_effect([response])
        await asyncio.wait_for(
            draft_route_for_human(
                llm=llm,
                description="Now add a lunch stop.",
                history=[
                    {"role": "user", "content": "Draft a relaxed day."},
                    {"role": "ai", "content": "Here is a relaxed route."},
                ],
            ),
            timeout=RUN_TIMEOUT,
        )

    messages = mock_llm.await_args.kwargs["messages"]
    assert messages[0]["role"] == "system"
    assert messages[1] == {"role": "user", "content": "Draft a relaxed day."}
    assert messages[2] == {"role": "assistant", "content": "Here is a relaxed route."}
    assert messages[3]["role"] == "user"
    assert "Now add a lunch stop." in messages[3]["content"]

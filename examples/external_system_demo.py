"""Minimal end-to-end demo: an external recommender joins an LLM-agent meeting.

The system asks Alice about her preferences first, then has an LLM draft a
route from the discussion (parsed straight into RouteDraft via structured
outputs); the LLM agents discuss and vote on it.
"""
import asyncio

from openai import OpenAI

from tour_meeting.cli import build_meeting
from tour_meeting.integration import ExternalSystem
from tour_meeting.types import (
    Ask,
    ExternalSystemAsk,
    ExternalSystemTurn,
    ExternalSystemVote,
    Propose,
    RouteDraft,
    Vote,
)

MODEL = "gpt-5.4-mini"
client = OpenAI()


class MyRecSys(ExternalSystem):
    name = "RecSys"
    system_prompt = "You are a recommender system for short sightseeing tours in Kyoto."

    def on_turn(self, event: ExternalSystemTurn):
        # First, spend a step asking an agent about their preferences;
        # on the last step (event.can_ask is False), conclude with a proposal.
        if event.can_ask and not event.ask_exchanges:
            return Ask(target=event.candidates[0],
                       message="What do you want to prioritize on this trip?")
        draft = self.recommend(event)
        return Propose(message=draft.message, route=draft.route)

    def recommend(self, event: ExternalSystemTurn) -> RouteDraft:
        conversation = "\n".join(
            f"{m['speaker']}: {m['text']}" for m in event.conversation_history
        )
        answers = "\n".join(
            f"{a['target']}: {a['response']}" for a in event.ask_exchanges
        )
        response = client.responses.parse(
            model=MODEL,
            input=[
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": (
                    "Based on the following discussion, recommend a short morning "
                    f"route (2-3 stops):\n{conversation}\n\n"
                    f"Answers you collected from the participants:\n{answers}"
                )},
            ],
            text_format=RouteDraft,
        )
        return response.output_parsed

    def on_vote(self, event: ExternalSystemVote):
        # A vote on another participant's proposal
        proposal = event.options["proposals"][0]
        accept = len(proposal["destinations"]) >= 2  # your own criteria here
        return Vote(accept=accept, message="Works for me." if accept else "I disagree.")

    def on_ask(self, event: ExternalSystemAsk) -> str:
        conversation = "\n".join(
            f"{m['speaker']}: {m['text']}" for m in event.conversation_history
        )
        response = client.responses.create(
            model=MODEL,
            input=[
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": (
                    f"Discussion so far:\n{conversation}\n\n"
                    f"{event.asker} asked you: {event.question}\nAnswer briefly."
                )},
            ],
        )
        return response.output_text


def persona(name, prefs):
    return {
        "name": name,
        "model_name": f"openai/{MODEL}",
        "background": f"{name} is visiting Kyoto for the first time.",
        "personality": "Friendly and concise.",
        "preferences": prefs,
        "personal_goals": "Agree on a short, realistic morning itinerary.",
        "temperature": 1,  # gpt-5 models only support temperature=1
        "max_steps": 2,
        "web_search": False,
    }


meeting = build_meeting(
    title="Kyoto Morning Tour",
    global_goals="Agree on a short morning sightseeing route in Kyoto.",
    participants=[
        MyRecSys(),
        persona("Alice", "Shrines and photogenic spots."),
        persona("Bob", "Quiet temples, low budget."),
    ],
    settings={
        "turn_rule": "round_robin",
        "voting_rule": "majority",
        "max_turns": 6,
    },
)

asyncio.run(meeting.run_cli())

print("\n=== final route ===")
print(meeting.final_route)

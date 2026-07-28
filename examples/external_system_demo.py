"""Minimal end-to-end demo: an external recommender joins an LLM-agent meeting.

The system asks Alice about her budget first, then proposes a fixed Kyoto
route; the LLM agents (gpt-5.4-mini) discuss and vote on it.
"""
import asyncio

from tour_meeting.cli import build_meeting
from tour_meeting.integration import ExternalSystem
from tour_meeting.types import (
    Ask,
    Destination,
    ExternalSystemTurn,
    ExternalSystemVote,
    Propose,
    Vote,
)


class MyRecSys(ExternalSystem):
    name = "RecSys"

    def on_turn(self, event: ExternalSystemTurn):
        if event.can_ask and not event.ask_exchanges:
            return Ask(target=event.candidates[0],
                       message="What do you want to prioritize on this trip?")
        print(f"\n>>> [RecSys] answers collected: {event.ask_exchanges}")
        return Propose(
            message="Based on your preferences, how about this classic route?",
            route=[
                Destination(
                    name="Fushimi Inari", description="Thousands of torii gates.",
                    start_time="09:00", stay_duration="90 min", cost="¥0",
                    transport_mode="train", travel_time_from_previous="5 min",
                    transport_cost="¥150",
                ),
                Destination(
                    name="Tofuku-ji", description="Zen temple with gardens.",
                    start_time="10:45", stay_duration="60 min", cost="¥600",
                    transport_mode="train", travel_time_from_previous="10 min",
                    transport_cost="¥150",
                ),
            ],
        )

    def on_vote(self, event: ExternalSystemVote):
        return Vote(accept=True, message="Happy with the accepted route.")

    def on_ask(self, event):
        return "I recommend places that match everyone's stated preferences."


def persona(name, prefs):
    return {
        "name": name,
        "model_name": "openai/gpt-5.4-mini",
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

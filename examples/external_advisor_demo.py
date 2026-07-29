"""Minimal end-to-end demo: an external advisor guides an LLM-agent meeting.

The advisor takes no seat: it observes every event, has an LLM review each
adopted itinerary, and injects advice that every agent sees on their next
turn (look for the "[advice]" lines in the output).
"""
import asyncio

from openai import OpenAI

from tour_meeting.cli import build_meeting
from tour_meeting.integration import ExternalSystem
from tour_meeting.types import MeetingEvent, RoutePlanUpdate

MODEL = "gpt-5.4-mini"
client = OpenAI()


class MyAdvisor(ExternalSystem):
    name = "Advisor"
    system_prompt = "You are a critical reviewer of short sightseeing itineraries in Kyoto."

    def on_event(self, event: MeetingEvent) -> None:
        if isinstance(event, RoutePlanUpdate):
            # A new itinerary was adopted: let your system review it
            feedback = self.review(event.route_plan)
            if feedback:
                self.advise(feedback)

    def review(self, route_plan: dict) -> str:
        stops = "\n".join(
            f"- {d.get('name')} ({d.get('start_time')}, {d.get('stay_duration')}, {d.get('cost')})"
            for d in route_plan.get("destinations", [])
        )
        response = client.responses.create(
            model=MODEL,
            input=[
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": (
                    f"The group adopted this morning itinerary:\n{stops}\n\n"
                    "Point out the single biggest weakness (crowds, timing, cost, "
                    "or pacing) in one or two sentences, as advice to the group. "
                    "If it is already excellent, reply with exactly 'OK'."
                )},
            ],
        )
        text = response.output_text.strip()
        return "" if text == "OK" else text


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
        persona("Alice", "Shrines and photogenic spots."),
        persona("Bob", "Quiet temples, low budget."),
        MyAdvisor(),  # no seat: order doesn't matter
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

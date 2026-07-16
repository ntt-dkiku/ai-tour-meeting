"""
Analytics and monitoring functionality for AI Tour Meeting.
Tracks discussion dynamics and tour route characteristics.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, List, Any, Optional, Tuple, Set
import json
import time

from .utils import sum_costs_by_currency


@dataclass
class ActivityMetrics:
    """Metrics for agent activity."""
    tokens_per_agent: Dict[str, int] = field(default_factory=dict)
    token_usage_per_agent: Dict[str, Dict[str, int]] = field(default_factory=dict)  # {"agent": {"input": 0, "output": 0, "cached": 0, "total": 0}}
    processing_time_per_agent: Dict[str, float] = field(default_factory=dict)
    turns_per_agent: Dict[str, int] = field(default_factory=dict)
    llm_calls: List[Dict[str, Any]] = field(default_factory=list)
    action_counts: Dict[str, Dict[str, int]] = field(default_factory=dict)  # {"agent": {"proposal": 2, "discuss": 5, ...}}
    compaction_events: List[Dict[str, Any]] = field(default_factory=list)

    def record_turn(self, agent_name: str, tokens: int, processing_time: float, token_usage: Optional[Dict[str, int]] = None):
        """Record a turn by an agent."""
        self.tokens_per_agent[agent_name] = self.tokens_per_agent.get(agent_name, 0) + tokens
        self.processing_time_per_agent[agent_name] = self.processing_time_per_agent.get(agent_name, 0.0) + processing_time
        self.turns_per_agent[agent_name] = self.turns_per_agent.get(agent_name, 0) + 1

        # Track detailed token usage if provided
        if token_usage:
            if agent_name not in self.token_usage_per_agent:
                self.token_usage_per_agent[agent_name] = {"input": 0, "output": 0, "cached": 0, "total": 0}
            self.token_usage_per_agent[agent_name]["input"] += token_usage.get("input", 0)
            self.token_usage_per_agent[agent_name]["output"] += token_usage.get("output", 0)
            self.token_usage_per_agent[agent_name]["cached"] += token_usage.get("cached", 0)
            self.token_usage_per_agent[agent_name]["total"] += token_usage.get("total", 0)

    def total_tokens(self) -> int:
        """Total tokens generated across all agents."""
        return sum(self.tokens_per_agent.values())

    def total_processing_time(self) -> float:
        """Total processing time across all agents."""
        return sum(self.processing_time_per_agent.values())

    def total_turns(self) -> int:
        """Total number of turns."""
        return sum(self.turns_per_agent.values())

    def record_llm_calls(self, calls: List[Dict[str, Any]]):
        """Append per-step LLM call records (turn, speaker, step, call_type, prompt_tokens)."""
        self.llm_calls.extend(calls)

    def record_action(self, agent_name: str, action: str):
        """Record an action chosen by an agent (e.g. proposal, discuss, satisfied, pass)."""
        if agent_name not in self.action_counts:
            self.action_counts[agent_name] = {}
        self.action_counts[agent_name][action] = self.action_counts[agent_name].get(action, 0) + 1

    def record_compaction(self, agent_name: str, turn: int, tokens_before: int, tokens_after: int):
        """Record a context compaction event."""
        self.compaction_events.append({
            "turn": turn,
            "agent": agent_name,
            "tokens_before": tokens_before,
            "tokens_after": tokens_after,
        })


@dataclass
class ProposalMetrics:
    """Metrics for proposal behavior."""
    modifications_per_agent: Dict[str, int] = field(default_factory=dict)
    accepted_modifications_per_agent: Dict[str, int] = field(default_factory=dict)
    proposals_history: List[Dict[str, Any]] = field(default_factory=list)

    def record_proposal(self, agent_name: str, proposal_data: Dict[str, Any], turn: int):
        """Record a modification proposal."""
        import logging
        logger = logging.getLogger(__name__)

        self.modifications_per_agent[agent_name] = self.modifications_per_agent.get(agent_name, 0) + 1
        self.proposals_history.append({
            "turn": turn,
            "agent": agent_name,
            "proposal": proposal_data,
            "accepted": False
        })
        logger.debug(f"[Analytics] proposal_made: agent={agent_name}, turn={turn}, total_proposals={self.total_modifications()}")

    def record_acceptance(self, agent_name: str, proposal_index: Optional[int] = None):
        """Record that a proposal was accepted."""
        import logging
        logger = logging.getLogger(__name__)

        self.accepted_modifications_per_agent[agent_name] = self.accepted_modifications_per_agent.get(agent_name, 0) + 1
        if proposal_index is not None and proposal_index < len(self.proposals_history):
            self.proposals_history[proposal_index]["accepted"] = True

        total_accepted = sum(self.accepted_modifications_per_agent.values())
        total_proposed = sum(self.modifications_per_agent.values())
        logger.debug(f"[Analytics] proposal_accepted: agent={agent_name}, index={proposal_index}, accepted={total_accepted}/{total_proposed}")

    def acceptance_rate(self, agent_name: Optional[str] = None) -> float:
        """Calculate acceptance rate for an agent or overall."""
        if agent_name:
            total = self.modifications_per_agent.get(agent_name, 0)
            accepted = self.accepted_modifications_per_agent.get(agent_name, 0)
        else:
            total = sum(self.modifications_per_agent.values())
            accepted = sum(self.accepted_modifications_per_agent.values())

        return accepted / total if total > 0 else 0.0

    def total_modifications(self) -> int:
        """Total number of modification proposals."""
        return sum(self.modifications_per_agent.values())


@dataclass
class ConsensusMetrics:
    """Metrics for consensus formation."""
    # Approval voting (without scores)
    approval_votes_per_agent: Dict[str, int] = field(default_factory=dict)
    approval_relationships: List[Tuple[str, str]] = field(default_factory=list)  # (voter, votee)
    reject_votes_per_agent: Dict[str, int] = field(default_factory=dict)
    reject_relationships: List[Tuple[str, str]] = field(default_factory=list)  # (voter, votee)

    # Score-based voting
    score_distributions: List[Dict[str, Any]] = field(default_factory=list)
    scores_per_agent: Dict[str, List[float]] = field(default_factory=dict)

    def record_vote(
        self,
        voter: str,
        votee: str,
        score: Optional[float] = None,
        turn: int = 0,
        approved: bool = True,
    ):
        """Record a voting action."""
        if score is not None:
            # Score-based voting
            self.score_distributions.append({
                "turn": turn,
                "voter": voter,
                "votee": votee,
                "score": score
            })
            if voter not in self.scores_per_agent:
                self.scores_per_agent[voter] = []
            self.scores_per_agent[voter].append(score)
        else:
            # Approval voting (no score)
            if approved:
                self.approval_votes_per_agent[voter] = self.approval_votes_per_agent.get(voter, 0) + 1
                self.approval_relationships.append((voter, votee))
            else:
                self.reject_votes_per_agent[voter] = self.reject_votes_per_agent.get(voter, 0) + 1
                self.reject_relationships.append((voter, votee))

    def total_approval_votes(self) -> int:
        """Total number of approval voting actions."""
        return sum(self.approval_votes_per_agent.values())

    def total_reject_votes(self) -> int:
        """Total number of reject voting actions."""
        return sum(self.reject_votes_per_agent.values())

    def total_binary_votes(self) -> int:
        """Total number of non-scoring voting actions (approval + reject)."""
        return self.total_approval_votes() + self.total_reject_votes()

    def received_approval_votes_per_agent(self) -> Dict[str, int]:
        """Approval votes received by each agent/proposal owner."""
        received: Dict[str, int] = {}
        for _, votee in self.approval_relationships:
            if not votee:
                continue
            received[votee] = received.get(votee, 0) + 1
        return received

    def received_reject_votes_per_agent(self) -> Dict[str, int]:
        """Reject votes received by each agent/proposal owner."""
        received: Dict[str, int] = {}
        for _, votee in self.reject_relationships:
            if not votee:
                continue
            received[votee] = received.get(votee, 0) + 1
        return received

    def total_score_votes(self) -> int:
        """Total number of score-based voting actions."""
        return len(self.score_distributions)

    def score_stats(self) -> Dict[str, float]:
        """Calculate score distribution statistics (all agents)."""
        if not self.score_distributions:
            return {"mean": 0.0, "min": 0.0, "max": 0.0, "std": 0.0}

        scores = [d["score"] for d in self.score_distributions]
        mean = sum(scores) / len(scores)
        variance = sum((s - mean) ** 2 for s in scores) / len(scores)
        std = variance ** 0.5

        return {
            "mean": mean,
            "min": min(scores),
            "max": max(scores),
            "std": std
        }

    def score_stats_per_agent(self) -> Dict[str, Dict[str, float]]:
        """Calculate score distribution statistics per agent (scores given by each agent)."""
        agent_stats: Dict[str, Dict[str, float]] = {}

        for agent, scores in self.scores_per_agent.items():
            if not scores:
                continue

            mean = sum(scores) / len(scores)
            variance = sum((s - mean) ** 2 for s in scores) / len(scores)
            std = variance ** 0.5

            agent_stats[agent] = {
                "mean": mean,
                "min": min(scores),
                "max": max(scores),
                "std": std,
                "count": len(scores)
            }

        return agent_stats

    def received_score_stats_per_agent(self) -> Dict[str, Dict[str, float]]:
        """Calculate score distribution statistics per agent (scores received by each agent/proposal)."""
        received_scores_per_agent: Dict[str, List[float]] = {}

        # Group scores by votee (recipient)
        for entry in self.score_distributions:
            votee = entry.get("votee")
            score = entry.get("score")
            if votee and score is not None:
                if votee not in received_scores_per_agent:
                    received_scores_per_agent[votee] = []
                received_scores_per_agent[votee].append(score)

        # Calculate statistics for each agent
        agent_stats: Dict[str, Dict[str, float]] = {}
        for agent, scores in received_scores_per_agent.items():
            if not scores:
                continue

            mean = sum(scores) / len(scores)
            variance = sum((s - mean) ** 2 for s in scores) / len(scores)
            std = variance ** 0.5

            agent_stats[agent] = {
                "mean": mean,
                "min": min(scores),
                "max": max(scores),
                "std": std,
                "count": len(scores)
            }

        return agent_stats

    def get_all_scores(self) -> List[float]:
        """Get all scores as a flat list."""
        return [d["score"] for d in self.score_distributions]

    def get_scores_by_agent(self) -> Dict[str, List[float]]:
        """Get scores given by each agent."""
        return {agent: list(scores) for agent, scores in self.scores_per_agent.items()}

    def get_received_scores_by_agent(self) -> Dict[str, List[float]]:
        """Get scores received by each agent."""
        received_scores_per_agent: Dict[str, List[float]] = {}
        for entry in self.score_distributions:
            votee = entry.get("votee")
            score = entry.get("score")
            if votee and score is not None:
                if votee not in received_scores_per_agent:
                    received_scores_per_agent[votee] = []
                received_scores_per_agent[votee].append(score)
        return received_scores_per_agent


@dataclass
class RouteCharacteristics:
    """Metrics for tour route characteristics."""
    route_snapshots: List[Dict[str, Any]] = field(default_factory=list)
    time_corrections: List[Dict[str, Any]] = field(default_factory=list)

    def record_time_corrections(self, turn: int, speaker: str, adjustments: List[str]):
        """Record time corrections applied by correct_route_times().

        Each adjustment string has the form '- <name>: <old_time> -> <new_time>'.
        """
        for adj in adjustments:
            self.time_corrections.append({
                "turn": turn,
                "speaker": speaker,
                "adjustment": adj,
            })

    def _accepted_snapshots(self) -> List[Dict[str, Any]]:
        """Return only snapshots that represent accepted routes."""
        return [s for s in self.route_snapshots if s.get("phase") == "accepted"]

    def _route_signature(self, route_data: Dict[str, Any]) -> str:
        """Build a stable signature for route content equality checks."""
        try:
            return json.dumps(route_data, sort_keys=True, ensure_ascii=True, default=str)
        except Exception:
            # Fallback for unexpected non-serializable values.
            return repr(route_data)

    def record_route(self, turn: int, route_data: Dict[str, Any], phase: str = "unknown"):
        """Record a route state at a specific turn."""
        destinations = route_data.get("destinations", [])
        travel_time = self._calculate_travel_time(route_data)
        cost_by_currency = self._calculate_cost_by_currency(route_data)
        cost = sum(cost_by_currency.values())

        # Debug logging
        import logging
        logger = logging.getLogger(__name__)
        logger.debug(f"[Analytics] Recording route: turn={turn}, phase={phase}, destinations={len(destinations)}, travel_time={travel_time}, cost={cost_by_currency}")

        # Check if this is actually a different route from the last one
        if self.route_snapshots:
            last_snapshot = self.route_snapshots[-1]
            last_signature = last_snapshot.get("route_signature", "")
            current_signature = self._route_signature(route_data)
            if last_signature == current_signature and last_snapshot.get("phase") == phase:
                logger.debug(f"[Analytics] Skipping duplicate route snapshot")
                return

        snapshot = {
            "turn": turn,
            "phase": phase,
            "destinations": destinations,
            "travel_time": travel_time,
            "cost": cost,
            "cost_by_currency": cost_by_currency,
            "num_destinations": len(destinations),
            "route_signature": self._route_signature(route_data),
        }
        self.route_snapshots.append(snapshot)

    def _calculate_travel_time(self, route_data: Dict[str, Any]) -> float:
        """Calculate total travel time from route data."""
        total_time = 0.0
        for dest in route_data.get("destinations", []):
            if isinstance(dest, dict):
                travel_time = dest.get("travel_time_from_previous", 0)
                stay_duration = dest.get("stay_duration", 0)

                # Convert to float if string
                if isinstance(travel_time, str):
                    travel_time = self._parse_time_string(travel_time)
                if isinstance(stay_duration, str):
                    stay_duration = self._parse_time_string(stay_duration)

                total_time += float(travel_time or 0) + float(stay_duration or 0)

        return total_time

    def _calculate_cost_by_currency(self, route_data: Dict[str, Any]) -> Dict[str, float]:
        """Calculate total cost per currency symbol from route data.

        Numeric (non-string) costs are grouped under '' (unknown currency).
        """
        texts: List[Optional[str]] = []
        for dest in route_data.get("destinations", []):
            if isinstance(dest, dict):
                for field_name in ("cost", "transport_cost"):
                    value = dest.get(field_name, 0)
                    if isinstance(value, (int, float)):
                        value = str(value)
                    texts.append(value)
        return sum_costs_by_currency(texts)

    def _parse_time_string(self, time_str: str) -> float:
        """Parse time string to minutes."""
        import re
        if not time_str or not isinstance(time_str, str):
            return 0.0

        time_str = time_str.lower().strip()
        hours = 0.0
        minutes = 0.0

        # Match hours
        hour_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:h|hr|hour|hours|B�)", time_str)
        if hour_match:
            hours = float(hour_match.group(1))

        # Match minutes
        min_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:m|min|minute|minutes|)", time_str)
        if min_match:
            minutes = float(min_match.group(1))

        # If no units found, assume minutes
        if hours == 0.0 and minutes == 0.0:
            num_match = re.search(r"(\d+(?:\.\d+)?)", time_str)
            if num_match:
                minutes = float(num_match.group(1))

        return hours * 60 + minutes

    def travel_time_transition(self) -> List[Tuple[int, float]]:
        """Get travel time transition over turns."""
        accepted = self._accepted_snapshots()
        return [(s["turn"], s["travel_time"]) for s in accepted]

    def cost_transition(self) -> Dict[str, List[Tuple[int, float]]]:
        """Get cost transition over turns, as one series per currency symbol.

        E.g. {"¥": [(2, 2300), (4, 2500)], "$": [(2, 20), (4, 20)]}.
        Snapshots recorded before per-currency tracking fall back to their
        aggregate float cost under the '' (unknown currency) key.
        """
        accepted = self._accepted_snapshots()
        symbols: List[str] = []
        for s in accepted:
            by_currency = s.get("cost_by_currency")
            if by_currency is None:
                by_currency = {"": s.get("cost", 0.0)}
            for symbol in by_currency:
                if symbol not in symbols:
                    symbols.append(symbol)
        series: Dict[str, List[Tuple[int, float]]] = {}
        for symbol in symbols:
            points = []
            for s in accepted:
                by_currency = s.get("cost_by_currency")
                if by_currency is None:
                    by_currency = {"": s.get("cost", 0.0)}
                points.append((s["turn"], float(by_currency.get(symbol, 0.0))))
            if any(v for _, v in points):
                series[symbol] = points
        return series

    def destination_count_transition(self) -> List[Tuple[int, int]]:
        """Get destination count transition over turns."""
        accepted = self._accepted_snapshots()
        return [(s["turn"], s["num_destinations"]) for s in accepted]

    def destination_coverage(self, all_proposed_destinations: Optional[set] = None) -> float:
        """Calculate destination coverage rate."""
        accepted = self._accepted_snapshots()
        if not accepted or not all_proposed_destinations:
            return 0.0

        final_route = accepted[-1]
        final_destinations = set()
        for dest in final_route.get("destinations", []):
            if isinstance(dest, dict):
                name = dest.get("name")
                if name:
                    final_destinations.add(name)

        return len(final_destinations) / len(all_proposed_destinations) if all_proposed_destinations else 0.0

    def final_destinations_count(self) -> int:
        """Get the number of destinations in the final route."""
        accepted = self._accepted_snapshots()
        if not accepted:
            return 0

        final_route = accepted[-1]
        final_destinations = set()
        for dest in final_route.get("destinations", []):
            if isinstance(dest, dict):
                name = dest.get("name")
                if name:
                    final_destinations.add(name)

        return len(final_destinations)


@dataclass
class DiscussionDynamics:
    """Container for all discussion dynamics metrics."""
    activity: ActivityMetrics = field(default_factory=ActivityMetrics)
    proposals: ProposalMetrics = field(default_factory=ProposalMetrics)
    consensus: ConsensusMetrics = field(default_factory=ConsensusMetrics)

    def summary(self) -> Dict[str, Any]:
        """Generate a summary of discussion dynamics."""
        return {
            "activity": {
                "total_tokens": self.activity.total_tokens(),
                "total_processing_time": self.activity.total_processing_time(),
                "total_turns": self.activity.total_turns(),
                "tokens_per_agent": dict(self.activity.tokens_per_agent),
                "token_usage_per_agent": dict(self.activity.token_usage_per_agent),
                "processing_time_per_agent": dict(self.activity.processing_time_per_agent),
                "turns_per_agent": dict(self.activity.turns_per_agent),
                "llm_calls": self.activity.llm_calls,
                "action_counts": {k: dict(v) for k, v in self.activity.action_counts.items()},
                "compaction_events": self.activity.compaction_events,
            },
            "proposals": {
                "total_modifications": self.proposals.total_modifications(),
                "overall_acceptance_rate": self.proposals.acceptance_rate(),
                "modifications_per_agent": dict(self.proposals.modifications_per_agent),
                "accepted_modifications_per_agent": dict(self.proposals.accepted_modifications_per_agent),
                "acceptance_rate_per_agent": {
                    agent: self.proposals.acceptance_rate(agent)
                    for agent in self.proposals.modifications_per_agent.keys()
                }
            },
            "consensus": {
                "approval": {
                    "total_votes": self.consensus.total_binary_votes(),
                    "total_approval_votes": self.consensus.total_approval_votes(),
                    "total_reject_votes": self.consensus.total_reject_votes(),
                    # Backward-compatible alias used by older frontend versions.
                    "votes_per_agent": dict(self.consensus.approval_votes_per_agent),
                    "approval_votes_per_agent": dict(self.consensus.approval_votes_per_agent),
                    "reject_votes_per_agent": dict(self.consensus.reject_votes_per_agent),
                    "received_approval_votes_per_agent": self.consensus.received_approval_votes_per_agent(),
                    "received_reject_votes_per_agent": self.consensus.received_reject_votes_per_agent(),
                },
                "scoring": {
                    "total_votes": self.consensus.total_score_votes(),
                    "score_stats": self.consensus.score_stats(),
                    "score_stats_per_agent": self.consensus.score_stats_per_agent(),
                    "received_score_stats_per_agent": self.consensus.received_score_stats_per_agent(),
                    "all_scores": self.consensus.get_all_scores(),
                    "scores_by_agent": self.consensus.get_scores_by_agent(),
                    "received_scores_by_agent": self.consensus.get_received_scores_by_agent()
                }
            }
        }


class MeetingAnalytics:
    """Main analytics class for tracking all metrics during a meeting."""

    def __init__(self):
        self.discussion_dynamics = DiscussionDynamics()
        self.route_characteristics = RouteCharacteristics()
        self.all_proposed_destinations: Set[str] = set()
        self.start_time: Optional[float] = None
        self.end_time: Optional[float] = None
        self.termination_reason: Optional[str] = None
        self.satisfied_progression: List[Dict[str, Any]] = []
        self.post_consensus_evaluations: List[Dict[str, Any]] = []
        self.deadlock_interventions: List[Dict[str, Any]] = []
        self._turn_start_times: Dict[int, float] = {}

    def meeting_started(self):
        """Record that the meeting has started."""
        self.start_time = time.time()

    def meeting_finished(self, reason: str = "unknown"):
        """Record that the meeting has finished with a termination reason.

        reason: "consensus", "max_turns", "timeout", "stopped", or "unknown".
        """
        self.end_time = time.time()
        self.termination_reason = reason

    def turn_started(self, turn: int, agent_name: str):
        """Record that a turn has started."""
        _ = agent_name  # Reserved for future use
        self._turn_start_times[turn] = time.time()

    def turn_finished(self, turn: int, agent_name: str, output_text: str, token_usage: Optional[Dict[str, int]] = None):
        """Record that a turn has finished."""
        processing_time = 0.0
        if turn in self._turn_start_times:
            processing_time = time.time() - self._turn_start_times[turn]
            del self._turn_start_times[turn]

        # Estimate tokens if not provided (rough approximation)
        if token_usage is None:
            token_count = len(output_text.split())
            token_usage = {"input": 0, "output": token_count, "cached": 0, "total": token_count}
        else:
            token_count = token_usage.get("total", 0)

        self.discussion_dynamics.activity.record_turn(agent_name, token_count, processing_time, token_usage)

    def record_llm_calls(self, calls: List[Dict[str, Any]]):
        """Record per-step LLM call data (prompt_tokens etc.) for context size tracking."""
        self.discussion_dynamics.activity.record_llm_calls(calls)

    def proposal_made(self, agent_name: str, proposal_data: Dict[str, Any], turn: int):
        """Record that a proposal was made."""
        self.discussion_dynamics.proposals.record_proposal(agent_name, proposal_data, turn)

        # Track proposed destinations
        if "destinations" in proposal_data:
            for dest in proposal_data["destinations"]:
                if isinstance(dest, dict) and "name" in dest:
                    self.all_proposed_destinations.add(dest["name"])

    def proposal_accepted(self, agent_name: str, proposal_index: Optional[int] = None):
        """Record that a proposal was accepted."""
        self.discussion_dynamics.proposals.record_acceptance(agent_name, proposal_index)

    def vote_recorded(
        self,
        voter: str,
        votee: str,
        score: Optional[float] = None,
        turn: int = 0,
        approved: bool = True,
    ):
        """Record a vote."""
        self.discussion_dynamics.consensus.record_vote(voter, votee, score, turn, approved)

    def route_updated(self, turn: int, route_data: Dict[str, Any], phase: str = "unknown"):
        """Record a route update."""
        self.route_characteristics.record_route(turn, route_data, phase)

    def record_time_corrections(self, turn: int, speaker: str, adjustments: List[str]):
        """Record time corrections from correct_route_times()."""
        self.route_characteristics.record_time_corrections(turn, speaker, adjustments)

    def record_action(self, agent_name: str, action: str):
        """Record an action chosen by an agent."""
        self.discussion_dynamics.activity.record_action(agent_name, action)

    def record_satisfied_state(self, turn: int, speaker: str, satisfied_count: int, total_count: int):
        """Record the satisfied count after a satisfaction change."""
        self.satisfied_progression.append({
            "turn": turn,
            "speaker": speaker,
            "satisfied_count": satisfied_count,
            "total_count": total_count,
        })

    def record_compaction(self, agent_name: str, turn: int, tokens_before: int, tokens_after: int):
        """Record a context compaction event."""
        self.discussion_dynamics.activity.record_compaction(agent_name, turn, tokens_before, tokens_after)

    def record_deadlock_intervention(self, turn: int, signals: List[str], message: str):
        """Record a deadlock-intervention event injected by the system."""
        self.deadlock_interventions.append({
            "turn": turn,
            "signals": list(signals),
            "message": message,
        })

    def get_summary(self) -> Dict[str, Any]:
        """Generate a comprehensive summary of all metrics."""
        summary = {
            "discussion_dynamics": self.discussion_dynamics.summary(),
            "route_characteristics": {
                "travel_time_transition": self.route_characteristics.travel_time_transition(),
                "cost_transition": self.route_characteristics.cost_transition(),
                "destination_count_transition": self.route_characteristics.destination_count_transition(),
                "destination_coverage": self.route_characteristics.destination_coverage(self.all_proposed_destinations),
                "total_proposed_destinations": len(self.all_proposed_destinations),
                "final_destinations_count": self.route_characteristics.final_destinations_count(),
                "time_corrections": self.route_characteristics.time_corrections,
            },
            "meeting_duration": None,
            "termination_reason": self.termination_reason,
            "satisfied_progression": self.satisfied_progression,
            "deadlock_interventions": self.deadlock_interventions,
        }

        if self.start_time and self.end_time:
            summary["meeting_duration"] = self.end_time - self.start_time

        return summary

    def export_to_dict(self) -> Dict[str, Any]:
        """Export all metrics data to a dictionary."""
        return {
            "discussion_dynamics": {
                "activity": {
                    "tokens_per_agent": dict(self.discussion_dynamics.activity.tokens_per_agent),
                    "token_usage_per_agent": dict(self.discussion_dynamics.activity.token_usage_per_agent),
                    "processing_time_per_agent": dict(self.discussion_dynamics.activity.processing_time_per_agent),
                    "turns_per_agent": dict(self.discussion_dynamics.activity.turns_per_agent),
                    "llm_calls": list(self.discussion_dynamics.activity.llm_calls),
                    "action_counts": {k: dict(v) for k, v in self.discussion_dynamics.activity.action_counts.items()},
                    "compaction_events": list(self.discussion_dynamics.activity.compaction_events),
                },
                "proposals": {
                    "modifications_per_agent": dict(self.discussion_dynamics.proposals.modifications_per_agent),
                    "accepted_modifications_per_agent": dict(self.discussion_dynamics.proposals.accepted_modifications_per_agent),
                    "proposals_history": self.discussion_dynamics.proposals.proposals_history
                },
                "consensus": {
                    "approval_votes_per_agent": dict(self.discussion_dynamics.consensus.approval_votes_per_agent),
                    "approval_relationships": self.discussion_dynamics.consensus.approval_relationships,
                    "reject_votes_per_agent": dict(self.discussion_dynamics.consensus.reject_votes_per_agent),
                    "reject_relationships": self.discussion_dynamics.consensus.reject_relationships,
                    "score_distributions": self.discussion_dynamics.consensus.score_distributions,
                    "scores_per_agent": {k: list(v) for k, v in self.discussion_dynamics.consensus.scores_per_agent.items()}
                }
            },
            "route_characteristics": {
                "route_snapshots": self.route_characteristics.route_snapshots,
                "all_proposed_destinations": list(self.all_proposed_destinations),
                "time_corrections": self.route_characteristics.time_corrections,
            },
            "satisfied_progression": self.satisfied_progression,
            "post_consensus_evaluations": self.post_consensus_evaluations,
            "deadlock_interventions": self.deadlock_interventions,
            "metadata": {
                "start_time": self.start_time,
                "end_time": self.end_time,
                "duration": (self.end_time - self.start_time) if (self.start_time and self.end_time) else None,
                "termination_reason": self.termination_reason,
            }
        }

    def restore_from_dict(self, data: Dict[str, Any]) -> None:
        """Restore analytics state from a previously exported dict."""
        dd = data.get("discussion_dynamics", {})

        # Activity
        act = dd.get("activity", {})
        self.discussion_dynamics.activity.tokens_per_agent = dict(act.get("tokens_per_agent", {}))
        self.discussion_dynamics.activity.token_usage_per_agent = dict(act.get("token_usage_per_agent", {}))
        self.discussion_dynamics.activity.processing_time_per_agent = dict(act.get("processing_time_per_agent", {}))
        self.discussion_dynamics.activity.turns_per_agent = dict(act.get("turns_per_agent", {}))
        self.discussion_dynamics.activity.llm_calls = list(act.get("llm_calls", []))
        self.discussion_dynamics.activity.action_counts = {
            k: dict(v) for k, v in act.get("action_counts", {}).items()
        }
        self.discussion_dynamics.activity.compaction_events = list(act.get("compaction_events", []))

        # Proposals
        props = dd.get("proposals", {})
        self.discussion_dynamics.proposals.modifications_per_agent = dict(props.get("modifications_per_agent", {}))
        self.discussion_dynamics.proposals.accepted_modifications_per_agent = dict(props.get("accepted_modifications_per_agent", {}))
        self.discussion_dynamics.proposals.proposals_history = list(props.get("proposals_history", []))

        # Consensus
        cons = dd.get("consensus", {})
        self.discussion_dynamics.consensus.approval_votes_per_agent = dict(cons.get("approval_votes_per_agent", {}))
        self.discussion_dynamics.consensus.approval_relationships = [
            tuple(r) if isinstance(r, list) else r
            for r in cons.get("approval_relationships", [])
        ]
        self.discussion_dynamics.consensus.reject_votes_per_agent = dict(cons.get("reject_votes_per_agent", {}))
        self.discussion_dynamics.consensus.reject_relationships = [
            tuple(r) if isinstance(r, list) else r
            for r in cons.get("reject_relationships", [])
        ]
        self.discussion_dynamics.consensus.score_distributions = list(cons.get("score_distributions", []))
        self.discussion_dynamics.consensus.scores_per_agent = {
            k: list(v) for k, v in cons.get("scores_per_agent", {}).items()
        }

        # Satisfied progression
        self.satisfied_progression = list(data.get("satisfied_progression", []))
        self.deadlock_interventions = list(data.get("deadlock_interventions", []))

        # Route characteristics
        rc = data.get("route_characteristics", {})
        self.route_characteristics.route_snapshots = list(rc.get("route_snapshots", []))
        self.route_characteristics.time_corrections = list(rc.get("time_corrections", []))
        self.all_proposed_destinations = set(rc.get("all_proposed_destinations", []))

        # Metadata
        meta = data.get("metadata", {})
        self.start_time = meta.get("start_time")
        self.end_time = meta.get("end_time")
        self.termination_reason = meta.get("termination_reason")

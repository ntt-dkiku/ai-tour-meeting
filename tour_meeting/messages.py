"""Drop-in replacements for langchain_core.messages.HumanMessage / AIMessage."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Union


@dataclass
class HumanMessage:
    """Replacement for langchain_core.messages.HumanMessage."""

    content: Union[str, List[Any]]
    name: str = ""
    additional_kwargs: Dict[str, Any] = field(default_factory=dict)

    @property
    def type(self) -> str:
        return "human"

    def to_litellm_dict(self) -> Dict[str, Any]:
        """Convert to litellm message format ``{"role": "user", ...}``."""
        msg: Dict[str, Any] = {"role": "user", "content": self.content}
        if self.name:
            msg["name"] = self.name
        return msg


@dataclass
class AIMessage:
    """Replacement for langchain_core.messages.AIMessage."""

    content: Union[str, List[Any]]
    name: str = ""
    additional_kwargs: Dict[str, Any] = field(default_factory=dict)

    @property
    def type(self) -> str:
        return "assistant"

    def to_litellm_dict(self) -> Dict[str, Any]:
        """Convert to litellm message format ``{"role": "assistant", ...}``."""
        msg: Dict[str, Any] = {"role": "assistant", "content": self.content}
        if self.name:
            msg["name"] = self.name
        return msg


def history_to_litellm_messages(
    history: List[Union[HumanMessage, AIMessage]],
) -> List[Dict[str, Any]]:
    """Convert a list of HumanMessage/AIMessage to litellm message dicts."""
    return [msg.to_litellm_dict() for msg in history]

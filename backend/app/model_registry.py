from dataclasses import dataclass
from typing import Literal

ChatModel = Literal["kimi-k2.7-code", "grok-4.7", "gpt-6-luna"]


@dataclass(frozen=True)
class ModelSpec:
    name: str
    protocol: Literal["chat-completions", "responses"]


CHAT_MODELS: dict[ChatModel, ModelSpec] = {
    "kimi-k2.7-code": ModelSpec("Kimi K2.7 Code", "chat-completions"),
    "grok-4.7": ModelSpec("Grok 4.7", "responses"),
    "gpt-6-luna": ModelSpec("GPT‑6 Luna", "responses"),
}

from typing import Literal, Self
from uuid import UUID, uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

Strategy = Literal["direct", "steps", "prompt", "roles"]
Mode = Literal["direct", "steps", "prompt", "roles", "compare"]
StageName = Literal["prompt", "analyst", "implementer"]
Effort = Literal["low", "max"]
STRATEGIES: tuple[Strategy, ...] = ("direct", "steps", "prompt", "roles")


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)

    @field_validator("content")
    @classmethod
    def reject_blank_content(cls, content: str) -> str:
        if not content.strip():
            raise ValueError("Message must not be blank")
        return content


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    question: str = Field(min_length=1)
    mode: Mode = "direct"
    effort: Effort = "low"
    history: dict[Strategy, list[Message]] = Field(default_factory=dict)
    conversation_id: UUID = Field(default_factory=uuid4)

    @model_validator(mode="after")
    def validate_history(self) -> Self:
        if self.mode != "compare" and any(mode != self.mode for mode in self.history):
            raise ValueError("History must belong to the selected mode")
        for messages in self.history.values():
            if len(messages) % 2 or any(
                message.role != ("user" if index % 2 == 0 else "assistant")
                for index, message in enumerate(messages)
            ):
                raise ValueError("History must contain user/assistant pairs")
        return self


class Stage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: StageName
    content: str = Field(min_length=1)
    tokens: int = Field(ge=0)


class Result(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    mode: Strategy
    answer: str | None
    tokens: int | None = Field(ge=0)
    duration_ms: int = Field(ge=0)
    stages: list[Stage]
    error: str | None


class Answer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    question: str = Field(min_length=1)
    date: AwareDatetime
    mode: Mode
    effort: Effort
    tokens: int | None = Field(ge=0)
    results: list[Result]

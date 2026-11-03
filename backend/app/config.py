import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import dotenv_values

ROOT_DIR = Path(__file__).resolve().parents[2]
ALLOWED_MODELS = (
    "deepseek-v4.1-flash",
)


@dataclass(frozen=True)
class Settings:
    api_key: str = field(default="", repr=False)
    model: str = ALLOWED_MODELS[0]

    def __post_init__(self):
        if self.model not in ALLOWED_MODELS:
            raise ValueError(
                "OPENCODE_GO_MODEL must be one of: "
                + ", ".join(ALLOWED_MODELS)
            )


def load_settings() -> Settings:
    # Read only the repository's root .env; deployment variables take precedence.
    values = {**dotenv_values(ROOT_DIR / ".env"), **os.environ}
    return Settings(
        api_key=(values.get("OPENCODE_GO_API_KEY") or "").strip(),
        model=(values.get("OPENCODE_GO_MODEL") or ALLOWED_MODELS[0]).strip(),
    )

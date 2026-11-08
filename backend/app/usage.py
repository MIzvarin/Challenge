"""Optional pricing details; total_tokens is validated by the API adapters.

Sources: https://opencode.ai/docs/console/api/inference#cost and
https://api-docs.deepseek.com/api/create-chat-completion.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class TokenUsage:
    input: int  # Includes cache reads and writes.
    output: int  # Includes reasoning.
    cache_read: int
    cache_write: int | None


@dataclass(frozen=True)
class GeneratedAnswer:
    content: str
    tokens: int
    usage: TokenUsage | None


def _count(value: object) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("Invalid token count")
    return value


def normalize_usage(raw: object, protocol: str) -> TokenUsage | None:
    """Never reject otherwise valid generated text for missing pricing details."""
    if not isinstance(raw, dict):
        return None
    try:
        total = _count(raw.get("total_tokens"))
        if "opencode" in raw:
            # Console's billed input EXCLUDES both kinds of cache; output includes reasoning.
            details = raw["opencode"]["tokens"]
            read = _count(details.get("cache_read"))
            write = _count(details.get("cache_write_5m")) + _count(details.get("cache_write_1h"))
            incoming = _count(details.get("input")) + read + write
            outgoing = _count(details.get("output"))
            if "reasoning" in details and _count(details["reasoning"]) > outgoing:
                raise ValueError()
        else:
            responses = protocol == "responses"
            input_key, output_key = ("input_tokens", "output_tokens") if responses else ("prompt_tokens", "completion_tokens")
            incoming = _count(raw.get(input_key))
            outgoing = _count(raw.get(output_key))
            details = raw.get(f"{input_key}_details", {})
            if not isinstance(details, dict):
                raise ValueError()
            read = details.get("cached_tokens", raw.get("prompt_cache_hit_tokens"))
            read = _count(read)
            # Standard usage does not establish separately billed cache creation.
            # Console's extension above is needed for models charging it.
            write = None
        if incoming + outgoing != total or read + (write or 0) > incoming:
            raise ValueError()
        # If native categories accompany the extension they must agree, too.
        for key in ("prompt_tokens", "input_tokens"):
            if key in raw and _count(raw[key]) != incoming:
                raise ValueError()
            native = raw.get(f"{key}_details", {})
            if not isinstance(native, dict):
                raise ValueError()
            if "cached_tokens" in native and _count(native["cached_tokens"]) != read:
                raise ValueError()
        if "prompt_cache_hit_tokens" in raw and _count(raw["prompt_cache_hit_tokens"]) != read:
            raise ValueError()
        if "prompt_cache_miss_tokens" in raw and _count(raw["prompt_cache_miss_tokens"]) != incoming - read:
            raise ValueError()
        for key in ("completion_tokens", "output_tokens"):
            if key in raw and _count(raw[key]) != outgoing:
                raise ValueError()
            native = raw.get(f"{key}_details", {})
            if not isinstance(native, dict):
                raise ValueError()
            if "reasoning_tokens" in native and _count(native["reasoning_tokens"]) > outgoing:
                raise ValueError()
        return TokenUsage(incoming, outgoing, read, write)
    except (ValueError, TypeError, KeyError, AttributeError):
        return None

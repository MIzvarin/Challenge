"""Versioned USD / million text-token prices; no network access at runtime."""

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, localcontext

from .usage import TokenUsage
from .schemas import Cost

PRICING_VERSION = "opencode-go-2026-11-08-v1"
PRICING_SOURCE = "https://opencode.ai/docs/go/#usage-limits"


@dataclass(frozen=True)
class Rates:
    input: str
    read: str
    output: str
    write: str | None = None


RATES = {
    "deepseek-v4.1-flash": Rates("0.15", "0.003", "0.6"),
    "kimi-k2.7-code": Rates("0.95", "0.19", "4"),
    "grok-4.7": Rates("2", "0.5", "6"),
    "gpt-6-luna": Rates("0.1", "0.01", "0.5", "0.125"),
}
LONG_CONTEXT_RATES = {
    "grok-4.7": (200_000, Rates("4", "1", "12")),
    "gpt-6-luna": (272_000, Rates("0.2", "0.02", "0.75", "0.25")),
}


def estimate(model: str, usage: TokenUsage | None, started: datetime) -> Decimal | None:
    rates = RATES.get(model)
    if rates is None or usage is None:
        return None
    if started.tzinfo is None:
        return None
    override = LONG_CONTEXT_RATES.get(model)
    if override and usage.input > override[0]:
        rates = override[1]
    utc = started.astimezone(UTC)
    peak = model == "deepseek-v4.1-flash" and utc.weekday() < 5 and (
        1 <= utc.hour < 4 or 6 <= utc.hour < 10
    )
    if usage.cache_write and rates.write is None:
        return None
    if rates.write is not None and usage.cache_write is None:
        return None
    write = usage.cache_write or 0
    with localcontext() as context:
        context.prec = max(len(str(usage.input)), len(str(usage.output))) + 30
        return (
            (usage.input - usage.cache_read - write) * Decimal(rates.input)
            + usage.cache_read * Decimal(rates.read)
            + write * Decimal(rates.write or "0")
            + usage.output * Decimal(rates.output)
        ) * (2 if peak else 1) / 1_000_000


def price(model: str, usage: TokenUsage | None, started: datetime) -> Cost | None:
    amount = estimate(model, usage, started)
    return None if amount is None else Cost(
        amount=format(amount, "f"), currency="USD", pricing_version=PRICING_VERSION, source=PRICING_SOURCE,
    )


def sum_costs(costs: list[Cost | None]) -> Cost | None:
    if not costs or any(cost is None for cost in costs):
        return None
    known = [cost for cost in costs if cost is not None]
    first = known[0]
    if any((cost.pricing_version, cost.source) != (first.pricing_version, first.source) for cost in known):
        return None
    with localcontext() as context:
        context.prec = sum(len(cost.amount) for cost in known) + 10
        total = sum((Decimal(cost.amount) for cost in known), Decimal(0))
    return first.model_copy(update={"amount": format(total, "f")})

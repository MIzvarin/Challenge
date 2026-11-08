from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.pricing import PRICING_SOURCE, PRICING_VERSION, RATES, estimate
from app.usage import TokenUsage

OFF_PEAK = datetime(2026, 11, 8, 12, tzinfo=UTC)


def test_snapshot_and_kimi_reference():
    assert set(RATES) == {"deepseek-v4.1-flash", "kimi-k2.7-code", "grok-4.7", "gpt-6-luna"}
    assert PRICING_VERSION == "opencode-go-2026-11-08-v1"
    assert PRICING_SOURCE.startswith("https://")
    assert estimate("kimi-k2.7-code", TokenUsage(1000, 200, 400, 0), OFF_PEAK) == Decimal("0.001446")


def test_zero_unknown_and_unsupported_write():
    for model in RATES:
        assert estimate(model, TokenUsage(0, 0, 0, 0), OFF_PEAK) == 0
        assert estimate(model, None, OFF_PEAK) is None
    assert estimate("kimi-k2.7", TokenUsage(10, 20, 0, 0), OFF_PEAK) is None
    assert estimate("kimi-k2.7-code", TokenUsage(10, 20, 0, 1), OFF_PEAK) is None


def test_cache_write_is_not_also_regular_input():
    assert estimate("gpt-6-luna", TokenUsage(1000, 200, 400, 100), OFF_PEAK) == Decimal("0.0001665")
    assert estimate("gpt-6-luna", TokenUsage(1000, 200, 400, None), OFF_PEAK) is None


def test_precision_does_not_round_large_counts():
    assert estimate("kimi-k2.7-code", TokenUsage(10**40 + 1, 0, 0, 0), OFF_PEAK) == Decimal("9500000000000000000000000000000000.00000095")


@pytest.mark.parametrize("model,limit,normal,high", [
    ("grok-4.7", 200000, "0.5", "1"),
    ("gpt-6-luna", 272000, "0.01", "0.02"),
])
def test_context_boundary_includes_cached_input(model, limit, normal, high):
    assert estimate(model, TokenUsage(limit, 0, limit, 0), OFF_PEAK) == Decimal(normal) * limit / 1_000_000
    assert estimate(model, TokenUsage(limit + 1, 0, limit + 1, 0), OFF_PEAK) == Decimal(high) * (limit + 1) / 1_000_000


@pytest.mark.parametrize("day,hour,minute,factor", [
    (9, 0, 59, 1), (9, 1, 0, 2), (9, 3, 59, 2), (9, 4, 0, 1),
    (9, 5, 59, 1), (9, 6, 0, 2), (9, 9, 59, 2), (9, 10, 0, 1),
    (13, 2, 0, 2), (14, 2, 0, 1), (15, 2, 0, 1), (16, 2, 0, 2),
    (13, 23, 59, 1), (14, 0, 0, 1),
])
def test_peak_boundaries(day, hour, minute, factor):
    when = datetime(2026, 11, day, hour, minute, tzinfo=UTC)
    usage = TokenUsage(1000, 200, 400, 0)
    base = Decimal("0.0002112")
    assert estimate("deepseek-v4.1-flash", usage, when) == base * factor
    assert estimate("deepseek-v4.1-flash", usage, when.astimezone(timezone(timedelta(hours=5)))) == base * factor


def test_high_context_all_categories_and_naive_time():
    assert estimate("gpt-6-luna", TokenUsage(300000, 1000, 100000, 100000), OFF_PEAK) == Decimal("0.04775")
    assert estimate("grok-4.7", TokenUsage(300000, 1000, 100000, 0), OFF_PEAK) == Decimal("0.912")
    assert estimate("deepseek-v4.1-flash", TokenUsage(0, 0, 0, 0), datetime(2026, 11, 9)) is None

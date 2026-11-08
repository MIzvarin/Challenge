import pytest

from app.usage import TokenUsage, normalize_usage


def chat_usage():
    return {"total_tokens": 1200, "prompt_tokens": 1000, "completion_tokens": 200,
            "prompt_tokens_details": {"cached_tokens": 400},
            "completion_tokens_details": {"reasoning_tokens": 100}}


def test_native_usage_and_reasoning_subset():
    assert normalize_usage(chat_usage(), "chat-completions") == TokenUsage(1000, 200, 400, None)
    assert normalize_usage({"total_tokens": 1200, "input_tokens": 1000, "output_tokens": 200,
                            "input_tokens_details": {"cached_tokens": 400}}, "responses") == TokenUsage(1000, 200, 400, None)


def test_deepseek_aliases_must_agree():
    raw = {**chat_usage(), "prompt_cache_hit_tokens": 400, "prompt_cache_miss_tokens": 600}
    assert normalize_usage(raw, "chat-completions") == TokenUsage(1000, 200, 400, None)
    del raw["prompt_tokens_details"]
    assert normalize_usage(raw, "chat-completions") == TokenUsage(1000, 200, 400, None)
    raw["prompt_cache_miss_tokens"] = 601
    assert normalize_usage(raw, "chat-completions") is None


def test_console_usage_cache_write_and_read_are_disjoint():
    raw = {"total_tokens": 1200, "opencode": {"tokens": {
        "input": 500, "output": 200, "reasoning": 100,
        "cache_read": 400, "cache_write_5m": 60, "cache_write_1h": 40,
    }}}
    assert normalize_usage(raw, "responses") == TokenUsage(1000, 200, 400, 100)
    raw["input_tokens"] = 500
    assert normalize_usage(raw, "responses") is None


@pytest.mark.parametrize("change", [
    {"prompt_tokens": -1}, {"prompt_tokens": True}, {"completion_tokens": "200"},
    {"total_tokens": 1}, {"prompt_tokens_details": None},
    {"prompt_tokens_details": {"cached_tokens": 1001}},
    {"prompt_tokens_details": {"cached_tokens": False}},
    {"prompt_cache_hit_tokens": 399},
    {"completion_tokens_details": {"reasoning_tokens": 201}},
    {"opencode": None}, {"opencode": {"tokens": {}}},
])
def test_bad_optional_details_do_not_raise(change):
    assert normalize_usage({**chat_usage(), **change}, "chat-completions") is None


def test_missing_details_are_not_invented():
    assert normalize_usage({"total_tokens": 0}, "responses") is None
    assert normalize_usage({"total_tokens": 1200, "input_tokens": 1000, "output_tokens": 200}, "responses") is None

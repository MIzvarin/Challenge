import asyncio
import json

import httpx
import pytest
from fastapi import HTTPException

from app.config import Settings
from app.model_registry import CHAT_MODELS
from app.opencode_go import API_BASE_URL, complete
from app.responses_go import complete_responses
from app.usage import GeneratedAnswer, TokenUsage


def test_fixed_model_registry():
    assert list(CHAT_MODELS) == ["kimi-k2.7-code", "grok-4.7", "gpt-6-luna"]
    assert [entry.protocol for entry in CHAT_MODELS.values()] == [
        "chat-completions", "responses", "responses",
    ]


@pytest.mark.parametrize("model", ["kimi-k2.7-code"])
def test_explicit_model_does_not_mutate_settings(model):
    calls = []
    messages = [{"role": "system", "content": "Русский"}, {"role": "user", "content": "Привет"}]
    settings = Settings(api_key="test-secret")

    def handler(request):
        calls.append(json.loads(request.content))
        assert str(request.url) == API_BASE_URL + "chat/completions"
        assert request.headers["authorization"] == "Bearer test-secret"
        assert request.headers["user-agent"] == "challenge-qa/0.1"
        assert request.headers["x-opencode-session"] == "session"
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "Ответ"}, "finish_reason": "stop"}],
            "usage": {"total_tokens": 0},
        })

    async def run():
        async with httpx.AsyncClient(base_url=API_BASE_URL, transport=httpx.MockTransport(handler)) as client:
            assert await complete(messages, settings, client, "session", {}, model=model) == GeneratedAnswer("Ответ", 0, None)
            await complete(messages, settings, client, "session", {
                "thinking": {"type": "enabled"}, "reasoning_effort": "low",
            })

    asyncio.run(run())
    assert calls[0] == {"model": model, "messages": messages, "stream": False}
    assert calls[1] == {
        "model": "deepseek-v4.1-flash", "messages": messages, "stream": False,
        "thinking": {"type": "enabled"}, "reasoning_effort": "low",
    }
    assert settings.model == "deepseek-v4.1-flash"


def responses_response():
    return {"status": "completed", "output": [
        {"type": "reasoning", "summary": [{"text": "Скрытые мысли"}]},
        {"type": "message", "role": "assistant", "status": "completed", "content": [
            {"type": "output_text", "text": " Ответ"}, {"type": "output_text", "text": "! "},
        ]},
    ], "usage": {"total_tokens": 0}}


@pytest.mark.parametrize("protocol", ["chat-completions", "responses"])
@pytest.mark.parametrize("details,expected", [
    ({}, None),
    ({"input": 1000, "output": 200, "cache_read": 400,
      "cache_write_5m": 0, "cache_write_1h": 0}, TokenUsage(1400, 200, 400, 0)),
    ({"input": -1, "output": 200, "cache_read": 400,
      "cache_write_5m": 0, "cache_write_1h": 0}, None),
])
def test_optional_price_details_preserve_valid_response(protocol, details, expected):
    calls = []

    def handler(request):
        calls.append(request)
        body = responses_response() if protocol == "responses" else {
            "choices": [{"message": {"content": "Ответ!"}, "finish_reason": "stop"}],
        }
        body["usage"] = {"total_tokens": 1600, "opencode": {"tokens": details}}
        return httpx.Response(200, json=body)

    async def run():
        async with httpx.AsyncClient(base_url=API_BASE_URL, transport=httpx.MockTransport(handler)) as client:
            if protocol == "responses":
                return await complete_responses([], Settings(api_key="secret"), client, "session", model="grok-4.7")
            return await complete([], Settings(api_key="secret"), client, "session", {})

    assert asyncio.run(run()) == GeneratedAnswer("Ответ!", 1600, expected)
    assert len(calls) == 1


@pytest.mark.parametrize("model", ["grok-4.7", "gpt-6-luna"])
def test_responses_wire_format(model):
    # Формат сверён с https://platform.openai.com/docs/api-reference/responses/create
    calls = []

    def handler(request):
        calls.append(request)
        assert request.method == "POST"
        assert str(request.url) == API_BASE_URL + "responses"
        assert request.headers["authorization"] == "Bearer test-secret"
        assert request.headers["x-opencode-session"] == "session"
        assert request.headers["user-agent"] == "challenge-qa/0.1"
        assert json.loads(request.content) == {
            "model": model, "stream": False, "store": False, "instructions": "Русский",
            "input": [
                {"role": "user", "content": "Первый"},
                {"role": "assistant", "content": "Ответ"},
                {"role": "user", "content": "Дальше"},
            ],
        }
        return httpx.Response(200, json=responses_response())

    async def run():
        async with httpx.AsyncClient(base_url=API_BASE_URL, transport=httpx.MockTransport(handler)) as client:
            return await complete_responses([
                {"role": "system", "content": "Русский"},
                {"role": "user", "content": "Первый"},
                {"role": "assistant", "content": "Ответ"},
                {"role": "user", "content": "Дальше"},
            ], Settings(api_key="test-secret"), client, "session", model=model)

    assert asyncio.run(run()) == GeneratedAnswer("Ответ!", 0, None)
    assert len(calls) == 1


@pytest.mark.parametrize("change", [
    {"status": "incomplete"}, {"status": "failed"}, {"status": "in_progress"},
    {"incomplete_details": {"reason": "max_output_tokens"}},
    {"output": []}, {"output": None}, {"output": [None]},
    {"output": [{"type": "reasoning", "summary": [{"text": "secret"}]}]},
    *[{"output": [{"type": "message", "role": "assistant", "status": status,
        "content": [{"type": "output_text", "text": "secret"}]}]} for status in ["incomplete", "in_progress", None]],
    *[{"output": [{"type": "message", "role": "assistant", "status": "completed",
        "content": content}]} for content in [
            [{"type": "refusal", "refusal": "secret"}],
            [{"type": "output_text", "text": "secret"}, {"type": "refusal", "refusal": "secret"}],
            [{"type": "output_text", "text": " "}], [{"type": "output_text", "text": 123}],
            [{"type": "output_text", "text": "secret", "error": {"message": "secret"}}],
            None, [],
        ]],
    {"output": [{"type": "message", "error": {"message": "secret"}}]},
    {"usage": {}}, *[{"usage": {"total_tokens": tokens}} for tokens in [-1, True, "12", 1.5, None]],
])
def test_responses_rejects_incomplete_or_invalid_response(change):
    body = {**responses_response(), **change}
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=body)

    async def run():
        async with httpx.AsyncClient(base_url=API_BASE_URL, transport=httpx.MockTransport(handler)) as client:
            await complete_responses([], Settings(api_key="secret"), client, "session", model="grok-4.7")

    with pytest.raises(HTTPException) as error:
        asyncio.run(run())
    assert error.value.status_code == 502
    assert "secret" not in error.value.detail
    assert len(calls) == 1


@pytest.mark.parametrize("model", list(CHAT_MODELS))
@pytest.mark.parametrize("status,expected", [(400, 502), (401, 503), (402, 503), (403, 503), (404, 502), (429, 429), (500, 502), (504, 504)])
@pytest.mark.parametrize("embedded", [False, True])
def test_model_errors_are_safe(model, status, expected, embedded):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200 if embedded else status, json={
            "error": {"code": status, "message": "secret", "metadata": {"raw": "secret"}},
        }, headers={"retry-after": "15"})

    async def run():
        async with httpx.AsyncClient(base_url=API_BASE_URL, transport=httpx.MockTransport(handler)) as client:
            if model != "kimi-k2.7-code":
                await complete_responses([], Settings(api_key="secret"), client, "session", model=model)
            else:
                await complete([], Settings(api_key="secret"), client, "session", {}, model=model)

    with pytest.raises(HTTPException) as error:
        asyncio.run(run())
    assert error.value.status_code == expected
    assert "secret" not in error.value.detail
    assert "DeepSeek" not in error.value.detail
    assert len(calls) == 1


@pytest.mark.parametrize("model", list(CHAT_MODELS))
@pytest.mark.parametrize("failure,status", [(httpx.ReadTimeout("secret"), 504), (httpx.ConnectError("secret"), 502)])
def test_model_network_errors(model, failure, status):
    calls = []

    def handler(request):
        calls.append(request)
        raise failure

    async def run():
        async with httpx.AsyncClient(base_url=API_BASE_URL, transport=httpx.MockTransport(handler)) as client:
            if model != "kimi-k2.7-code":
                await complete_responses([], Settings(api_key="secret"), client, "session", model=model)
            else:
                await complete([], Settings(api_key="secret"), client, "session", {}, model="kimi-k2.7-code")

    with pytest.raises(HTTPException) as error:
        asyncio.run(run())
    assert error.value.status_code == status
    assert "secret" not in error.value.detail
    assert len(calls) == 1

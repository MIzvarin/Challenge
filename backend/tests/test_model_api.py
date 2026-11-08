import json
from uuid import UUID, uuid4, uuid5

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.model_registry import CHAT_MODELS
from app.schemas import ModelQuestion
from app.solver import LANGUAGE_INSTRUCTION


def completion():
    return {"choices": [{"message": {"content": "Ответ"}, "finish_reason": "stop"}],
            "usage": {"total_tokens": 0}}


def make_client(handler, key="secret"):
    return TestClient(create_app(Settings(api_key=key), transport=httpx.MockTransport(handler)))


@pytest.mark.parametrize("payload", [
    {}, {"model": "unknown"}, {"model": None}, {"model": "beam-free"},
    {"model": "gemini-4-argon"}, {"model": "kimi-k2.7-code", "question": " "},
    {"model": "kimi-k2.7-code", "mode": "direct"}, {"model": "kimi-k2.7-code", "effort": None},
    {"model": "kimi-k2.7-code", "temperature": 0}, {"model": "kimi-k2.7-code", "thinking": {}},
    {"model": "kimi-k2.7-code", "conversation_id": "bad"},
    {"model": "kimi-k2.7-code", "history": {"roles": []}},
    {"model": "kimi-k2.7-code", "history": {"direct": [{"role": "user", "content": "x"}]}},
    {"model": "kimi-k2.7-code", "history": {"direct": [{"role": "system", "content": "x"}]}},
])
def test_invalid_model_question_never_calls_go(payload):
    with make_client(lambda request: pytest.fail("Invalid input reached Go")) as client:
        response = client.post("/api/ask-models", json={"question": "Привет", **payload})
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert response.headers["cache-control"] == "no-store"


def test_model_schema_defaults_and_openapi():
    question = ModelQuestion.model_validate({"question": " Привет ", "model": "kimi-k2.7-code"})
    assert question.question == "Привет"
    assert question.history == {}
    assert isinstance(question.conversation_id, UUID)
    with make_client(lambda request: pytest.fail("OpenAPI called Go")) as client:
        schemas = client.get("/openapi.json").json()["components"]["schemas"]
    assert schemas["ModelQuestion"]["additionalProperties"] is False
    assert schemas["ModelQuestion"]["required"] == ["question", "model"]
    assert "mode" not in schemas["ModelQuestion"]["properties"]
    assert schemas["ModelAnswer"]["additionalProperties"] is False
    assert "model" in schemas["ModelAnswer"]["required"]
    for name in ("ModelQuestion", "ModelAnswer"):
        assert schemas[name]["properties"]["model"]["enum"] == [
            "kimi-k2.7-code", "grok-4.7", "gpt-6-luna",
        ]
    for model in CHAT_MODELS:
        assert ModelQuestion(question="Привет", model=model).model == model


@pytest.mark.parametrize("model", list(CHAT_MODELS))
def test_one_selected_model_with_full_history_and_stable_session(model):
    calls = []
    generation = "2c904d3e-b129-48be-9528-1a3ddba32dc3"
    history = [{"role": "user", "content": "Первый"}, {"role": "assistant", "content": "Ответ"}]

    def handler(request):
        calls.append(request)
        body = json.loads(request.content)
        assert request.headers["x-opencode-session"] == str(uuid5(UUID(generation), f"models:{model}:direct"))
        assert request.headers["x-opencode-session"] != str(uuid5(UUID(generation), "low:direct:direct"))
        assert request.headers["authorization"] == "Bearer secret"
        assert request.headers["user-agent"] == "challenge-qa/0.1"
        if model != "kimi-k2.7-code":
            assert request.url.path == "/inference/go/openai/v1/responses"
            assert body == {
                "model": model, "stream": False, "store": False,
                "instructions": LANGUAGE_INSTRUCTION,
                "input": [*history, {"role": "user", "content": "Привет"}],
            }
            return httpx.Response(200, json={
                "status": "completed", "output": [{"type": "message", "role": "assistant",
                    "status": "completed", "content": [{"type": "output_text", "text": "Ответ"}]}],
                "usage": {"total_tokens": 0},
            })
        assert request.url.path == "/inference/go/openai/v1/chat/completions"
        assert body == {"model": model, "messages": [
            {"role": "system", "content": LANGUAGE_INSTRUCTION}, *history,
            {"role": "user", "content": "Привет"},
        ], "stream": False}
        return httpx.Response(200, json=completion())

    with make_client(handler) as client:
        for _ in range(2):
            response = client.post("/api/ask-models", json={
                "question": " Привет ", "model": model, "conversation_id": generation,
                "history": {"direct": history},
            })
            assert response.status_code == 200
            body = response.json()
            assert set(body) == {"question", "date", "model", "mode", "effort", "tokens", "results"}
            assert body["model"] == model and body["effort"] is None and body["tokens"] == 0
            assert len(body["results"]) == 1
            result = body["results"][0]
            assert result == {"mode": "direct", "answer": "Ответ", "tokens": 0,
                              "duration_ms": result["duration_ms"], "stages": [], "error": None}
            assert result["duration_ms"] >= 0
    assert len(calls) == 2


@pytest.mark.parametrize("status,expected", [(429, 429), (500, 502), (403, 503), (504, 504)])
def test_single_model_http_errors(status, expected):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(status, json={"error": {"message": "secret"}}, headers={"retry-after": "5"})

    with make_client(handler) as client:
        response = client.post("/api/ask-models", json={"question": "Привет", "model": "kimi-k2.7-code"})
    assert response.status_code == expected
    assert isinstance(response.json()["detail"], str)
    assert "secret" not in response.text
    assert response.headers["cache-control"] == "no-store"
    assert len(calls) == 1


def test_missing_key_and_common_limiter():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=completion())

    with make_client(handler, key="") as client:
        assert client.get("/api/health").status_code == 200
        assert client.post("/api/ask-models", json={"question": "Hi", "model": "kimi-k2.7-code"}).status_code == 503
    assert not calls
    with make_client(handler) as client:
        for i in range(10):
            path, payload = ("/api/ask", {"question": "Hi"}) if i % 2 else (
                "/api/ask-models", {"question": "Hi", "model": "kimi-k2.7-code"},
            )
            assert client.post(path, json=payload).status_code == 200
        response = client.post("/api/ask-models", json={"question": "Hi", "model": "kimi-k2.7-code"})
        assert response.status_code == 429
        assert int(response.headers["retry-after"]) > 0
    assert len(calls) == 10


def test_sessions_change_with_generation_and_model():
    sessions = []

    def handler(request):
        sessions.append(request.headers["x-opencode-session"])
        return httpx.Response(200, json={
            "status": "completed", "output": [{"type": "message", "role": "assistant",
                "status": "completed", "content": [{"type": "output_text", "text": "Ответ"}]}],
            "usage": {"total_tokens": 0},
        } if request.url.path.endswith("responses") else completion())

    with make_client(handler) as client:
        for generation in [str(uuid4()), str(uuid4())]:
            for model in CHAT_MODELS:
                assert client.post("/api/ask-models", json={
                    "question": "Hi", "model": model, "conversation_id": generation,
                }).status_code == 200
    assert len(set(sessions)) == 6

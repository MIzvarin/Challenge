import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import ALLOWED_MODELS, Settings, load_settings
from app.main import RateLimiter, create_app


def make_client(handler, api_key="test-secret", model=ALLOWED_MODELS[0]):
    return TestClient(
        create_app(Settings(api_key=api_key, model=model), transport=httpx.MockTransport(handler))
    )


def completion(answer="Привет!", finish_reason="stop"):
    return {
        "choices": [{"message": {"content": answer}, "finish_reason": finish_reason}]
    }


def test_question_is_sent_with_server_key():
    def handler(request):
        assert str(request.url) == "https://openrouter.ai/api/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer test-secret"
        payload = json.loads(request.content)
        assert payload["model"] == "nvidia/nemotron-3.5-lightning:free"
        assert payload["messages"][-1] == {"role": "user", "content": "Привет"}
        assert payload["max_completion_tokens"] == 2048
        assert payload["reasoning"] == {"enabled": False}
        assert payload["provider"]["max_price"] == {
            "prompt": "0", "completion": "0", "request": "0"
        }
        assert set(payload) == {"model", "messages", "max_completion_tokens", "reasoning", "provider", "stream"}
        assert payload["stream"] is False
        return httpx.Response(200, json=completion())

    with make_client(handler) as client:
        response = client.post("/api/ask", json={"question": "  Привет  "})
    assert response.status_code == 200
    assert response.json() == {
        "answer": "Привет!", "model": "nvidia/nemotron-3.5-lightning:free", "truncated": False
    }
    assert response.headers["cache-control"] == "no-store"
    assert "test-secret" not in response.text


@pytest.mark.parametrize("payload", [
    {}, {"question": ""}, {"question": " \n "}, {"question": "x" * 4001},
    {"question": 42}, {"question": "Hi", "model": "paid-model"},
])
def test_invalid_questions_never_call_provider(payload):
    def handler(request):
        pytest.fail("Invalid input must not reach OpenRouter")

    with make_client(handler) as client:
        response = client.post("/api/ask", json=payload)
    assert response.status_code == 422


def test_missing_key_never_calls_provider():
    def handler(request):
        pytest.fail("Missing key must not reach OpenRouter")

    with make_client(handler, api_key="") as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 503
    assert "OPENROUTER_API_KEY" in response.json()["detail"]


@pytest.mark.parametrize("provider_status, expected_status", [
    (401, 503), (402, 503), (403, 503), (429, 429), (400, 502), (404, 502),
    (408, 504), (500, 502), (502, 502), (503, 502), (524, 504), (529, 502),
])
def test_provider_errors_are_sanitized(provider_status, expected_status):
    def handler(request):
        return httpx.Response(
            provider_status, json={"error": "test-secret"}, headers={"retry-after": "15"}
        )

    with make_client(handler) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == expected_status
    assert "test-secret" not in response.text
    if provider_status == 429:
        assert response.headers["retry-after"] == "15"


@pytest.mark.parametrize("metadata, expected_text", [
    ({"provider_name": "Google AI Studio", "raw": "test-secret"}, "Провайдер выбранной модели"),
    ({"error_type": "rate_limit_exceeded"}, "OpenRouter ограничил запросы"),
    (None, "OpenRouter ограничил запросы"),
    ("invalid", "OpenRouter ограничил запросы"),
])
def test_rate_limit_source_is_explained_without_leaking_diagnostics(metadata, expected_text):
    def handler(request):
        return httpx.Response(429, json={"error": {"metadata": metadata, "message": "test-secret"}})

    with make_client(handler) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 429
    assert expected_text in response.json()["detail"]
    assert "test-secret" not in response.text


def test_non_json_rate_limit_is_handled():
    with make_client(lambda request: httpx.Response(429, text="test-secret")) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 429
    assert "OpenRouter ограничил запросы" in response.json()["detail"]
    assert "test-secret" not in response.text


@pytest.mark.parametrize("error, expected_status", [
    (httpx.ReadTimeout("timeout"), 504),
    (httpx.ConnectError("connection failed"), 502),
])
def test_network_errors(error, expected_status):
    def handler(request):
        raise error

    with make_client(handler) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == expected_status


@pytest.mark.parametrize("body", [
    {}, {"choices": []}, completion("  "), completion(None), {"choices": "invalid"},
])
def test_malformed_answers(body):
    with make_client(lambda request: httpx.Response(200, json=body)) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502


def test_invalid_json_from_provider():
    with make_client(lambda request: httpx.Response(200, text="not JSON")) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502


def test_truncated_answer_is_marked():
    with make_client(lambda request: httpx.Response(200, json=completion("Часть", "length"))) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.json()["truncated"] is True


@pytest.mark.parametrize("location", ["top", "choice"])
@pytest.mark.parametrize("code, expected_status", [(429, 429), (502, 502), (504, 504)])
def test_embedded_generation_errors_never_return_partial_answers(location, code, expected_status):
    body = completion("Partial answer test-secret", "error")
    error = {
        "code": code,
        "message": "test-secret",
        "metadata": {"provider_name": "Test provider", "raw": "test-secret"},
    }
    if location == "top":
        body["error"] = error
    else:
        body["choices"][0]["error"] = error

    with make_client(lambda request: httpx.Response(200, json=body)) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == expected_status
    assert "answer" not in response.json()
    assert "test-secret" not in response.text
    if code == 429:
        assert "Провайдер выбранной модели" in response.json()["detail"]


def test_error_finish_reason_without_error_object_is_not_successful():
    with make_client(lambda request: httpx.Response(200, json=completion("Partial answer", "error"))) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502
    assert "answer" not in response.json()


@pytest.mark.parametrize("location", ["top", "choice"])
@pytest.mark.parametrize("error", [{}, "test-secret", {"code": 200}, {"code": "invalid"}])
def test_malformed_embedded_errors_do_not_turn_into_success(location, error):
    body = completion("Partial answer", "stop")
    if location == "top":
        body["error"] = error
    else:
        body["choices"][0]["error"] = error
    with make_client(lambda request: httpx.Response(200, json=body)) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502
    assert "test-secret" not in response.text


def test_error_only_response_uses_embedded_status_and_retry_after():
    body = {"error": {"code": 429, "message": "test-secret"}}
    with make_client(lambda request: httpx.Response(200, json=body, headers={"retry-after": "15"})) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 429
    assert response.headers["retry-after"] == "15"
    assert "test-secret" not in response.text


def test_null_error_fields_are_allowed_on_success():
    body = completion()
    body["error"] = None
    body["choices"][0]["error"] = None
    with make_client(lambda request: httpx.Response(200, json=body)) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 200


@pytest.mark.parametrize("content", [None, "", "  "])
def test_empty_length_response_explains_exhausted_budget(content):
    body = completion(content, "length")
    body["usage"] = {
        "completion_tokens": 2048,
        "completion_tokens_details": {"reasoning_tokens": 2048},
    }
    with make_client(lambda request: httpx.Response(200, json=body)) as client:
        response = client.post("/api/ask", json={"question": "Сложный вопрос"})
    assert response.status_code == 502
    assert "исчерпала лимит генерации" in response.json()["detail"]
    assert "Попробуйте ещё раз" not in response.json()["detail"]


def test_length_response_without_message_explains_exhausted_budget():
    body = {"choices": [{"finish_reason": "length"}]}
    with make_client(lambda request: httpx.Response(200, json=body)) as client:
        response = client.post("/api/ask", json={"question": "Сложный вопрос"})
    assert response.status_code == 502
    assert "исчерпала лимит генерации" in response.json()["detail"]


def test_app_limits_requests_before_calling_openrouter():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=completion())

    with make_client(handler) as client:
        for _ in range(10):
            assert client.post("/api/ask", json={"question": "Привет"}).status_code == 200
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 429
    assert int(response.headers["retry-after"]) > 0
    assert len(calls) == 10


def test_limiter_resets_after_window(monkeypatch):
    now = [0.0]
    monkeypatch.setattr("app.main.monotonic", lambda: now[0])
    limiter = RateLimiter(limit=1)
    limiter.check()
    now[0] = 60.0
    limiter.check()
    assert len(limiter.requests) == 1


def test_configuration_reads_root_env_and_prefers_environment(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text(
        "OPENROUTER_API_KEY=from-file\nOPENROUTER_MODEL=google/gemma-4-31b-it:free\n"
    )
    monkeypatch.setattr("app.config.ROOT_DIR", tmp_path)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_MODEL", raising=False)
    assert load_settings().api_key == "from-file"
    assert load_settings().model == "google/gemma-4-31b-it:free"
    monkeypatch.setenv("OPENROUTER_API_KEY", "from-environment")
    assert load_settings().api_key == "from-environment"
    assert "from-environment" not in repr(load_settings())


@pytest.mark.parametrize("model", [
    "paid-model", "google/gemma-4-31b-it", "nvidia/nemotron-3.5-lightning", "unknown/model:free",
])
def test_unsupported_model_is_rejected(model):
    with pytest.raises(ValueError):
        Settings(model=model)


@pytest.mark.parametrize("model", ALLOWED_MODELS)
def test_supported_models_use_only_free_routing(model):
    calls = []

    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        assert payload["model"] == model
        assert model.endswith(":free")
        assert payload["reasoning"] == {"enabled": False}
        assert all(price == "0" for price in payload["provider"]["max_price"].values())
        return httpx.Response(200, json=completion())

    with make_client(handler, model=model) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 200
    assert response.json()["model"] == model
    assert len(calls) == 1


def test_no_model_fallback_after_provider_failure():
    calls = []

    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(404, json={"error": "Unavailable"})

    with make_client(handler) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502
    assert "OPENROUTER_MODEL" in response.json()["detail"]
    assert len(calls) == 1


def test_env_is_not_public(tmp_path, monkeypatch):
    dist = tmp_path / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<h1>Challenge</h1>")
    (tmp_path / ".env").write_text("OPENROUTER_API_KEY=test-secret")
    monkeypatch.setattr("app.main.ROOT_DIR", tmp_path)
    with make_client(lambda request: httpx.Response(200, json=completion())) as client:
        assert client.get("/").status_code == 200
        for path in ("/.env", "/backend/app/config.py", "/%2e%2e/.env"):
            response = client.get(path)
            assert response.status_code == 404
            assert "test-secret" not in response.text

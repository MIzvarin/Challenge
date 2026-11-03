import json
from datetime import UTC, datetime
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import ALLOWED_MODELS, Settings, load_settings
from app.main import RateLimiter, create_app


def make_client(handler, api_key="test-secret", model=ALLOWED_MODELS[0]):
    return TestClient(
        create_app(Settings(api_key=api_key, model=model), transport=httpx.MockTransport(handler))
    )


def completion(answer="Привет!", finish_reason="stop", tokens=142):
    return {
        "choices": [{
            "message": {"content": json.dumps({"answer": answer}, ensure_ascii=False)},
            "finish_reason": finish_reason,
        }],
        "usage": {"total_tokens": tokens},
    }


def test_question_is_sent_with_server_key():
    def handler(request):
        assert str(request.url) == "https://opencode.ai/inference/go/openai/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer test-secret"
        assert request.headers["user-agent"] == "challenge-qa/0.1"
        assert UUID(request.headers["x-opencode-session"]).version == 4
        payload = json.loads(request.content)
        assert payload["model"] == "deepseek-v4.1-flash"
        assert payload["messages"][-1] == {"role": "user", "content": "Привет"}
        assert payload["max_tokens"] == 50
        assert "50 токенов" in payload["messages"][0]["content"]
        assert payload["stop"] == ["<END_OF_ANSWER>"]
        assert payload["response_format"]["type"] == "json_schema"
        json_schema = payload["response_format"]["json_schema"]
        assert json_schema["strict"] is True
        schema = json_schema["schema"]
        assert schema["type"] == "object"
        assert schema["required"] == ["answer"]
        assert set(schema["properties"]) == {"answer"}
        assert schema["additionalProperties"] is False
        assert payload["thinking"] == {"type": "disabled"}
        assert set(payload) == {
            "model", "messages", "max_tokens", "stop",
            "response_format", "thinking", "stream",
        }
        assert payload["stream"] is False
        return httpx.Response(200, json=completion())

    before = datetime.now(UTC)
    with make_client(handler) as client:
        response = client.post("/api/ask", json={"question": "  Привет  "})
    assert response.status_code == 200
    result = response.json()
    assert result == {
        "question": "Привет", "date": result["date"], "tokens": 142, "answer": "Привет!",
    }
    date = datetime.fromisoformat(result["date"])
    assert date.utcoffset().total_seconds() == 0
    assert before <= date <= datetime.now(UTC)
    assert response.headers["cache-control"] == "no-store"
    assert "test-secret" not in response.text


@pytest.mark.parametrize("payload", [
    {}, {"question": ""}, {"question": " \n "}, {"question": "x" * 4001},
    {"question": 42}, {"question": "Hi", "model": "paid-model"},
])
def test_invalid_questions_never_call_provider(payload):
    def handler(request):
        pytest.fail("Invalid input must not reach OpenCode Go")

    with make_client(handler) as client:
        response = client.post("/api/ask", json=payload)
    assert response.status_code == 422


def test_missing_key_never_calls_provider():
    def handler(request):
        pytest.fail("Missing key must not reach OpenCode Go")

    with make_client(handler, api_key="") as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 503
    assert "OPENCODE_GO_API_KEY" in response.json()["detail"]


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
    ({"provider_name": "DeepSeek", "raw": "test-secret"}, "OpenCode Go ограничил запросы"),
    ({"error_type": "rate_limit_exceeded"}, "OpenCode Go ограничил запросы"),
    (None, "OpenCode Go ограничил запросы"),
    ("invalid", "OpenCode Go ограничил запросы"),
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
    assert "OpenCode Go ограничил запросы" in response.json()["detail"]
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


def test_truncated_answer_is_rejected_even_if_json_is_complete():
    with make_client(lambda request: httpx.Response(200, json=completion("Часть", "length"))) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502
    assert "50 токенов" in response.json()["detail"]
    assert "answer" not in response.json()


@pytest.mark.parametrize("content", [
    'Простой текст test-secret', '```json\n{"answer":"Ответ"}\n```',
    '{"answer":"test-secret"', '[]', 'null', '{}',
    '{"answer":123}', '{"answer":null}', '{"answer":true}',
    '{"answer":""}', '{"answer":"  \\n "}',
    '{"answer":"Ответ","tokens":1}',
    '{"answer":"Ответ","question":"Подмена","date":"2000-01-01"}',
])
def test_model_output_must_match_strict_json_schema(content):
    body = completion()
    body["choices"][0]["message"]["content"] = content
    with make_client(lambda request: httpx.Response(200, json=body)) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502
    assert "test-secret" not in response.text
    assert "answer" not in response.json()


@pytest.mark.parametrize("usage", [
    None, {}, {"total_tokens": -1}, {"total_tokens": 1.5},
    {"total_tokens": "142"}, {"total_tokens": True},
])
def test_missing_or_invalid_usage_is_not_fabricated(usage):
    body = completion()
    body["usage"] = usage
    with make_client(lambda request: httpx.Response(200, json=body)) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502
    assert "tokens" not in response.json()


def test_long_question_is_preserved_without_model_echo_and_answer_is_trimmed():
    question = "В" * 4000
    body = completion("  Краткий ответ.  ", tokens=1800)
    with make_client(lambda request: httpx.Response(200, json=body)) as client:
        response = client.post("/api/ask", json={"question": question})
    assert response.status_code == 200
    result = response.json()
    assert result["question"] == question
    assert result["tokens"] == 1800
    assert result["answer"] == "Краткий ответ."


def test_api_response_schema_forbids_extra_fields_and_requires_metadata():
    with make_client(lambda request: httpx.Response(200, json=completion())) as client:
        schema = client.get("/openapi.json").json()["components"]["schemas"]["Answer"]
    assert schema["additionalProperties"] is False
    assert schema["required"] == ["question", "date", "tokens", "answer"]
    assert schema["properties"]["date"]["format"] == "date-time"
    assert schema["properties"]["tokens"]["type"] == "integer"
    assert schema["properties"]["tokens"]["minimum"] == 0


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
        assert "OpenCode Go ограничил запросы" in response.json()["detail"]


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
    body["choices"][0]["message"]["content"] = content
    body["usage"] = {
        "total_tokens": 100,
        "completion_tokens": 50,
        "completion_tokens_details": {"reasoning_tokens": 50},
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


def test_app_limits_requests_before_calling_opencode_go():
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
        "OPENCODE_GO_API_KEY=from-file\nOPENCODE_GO_MODEL=deepseek-v4.1-flash\n"
    )
    monkeypatch.setattr("app.config.ROOT_DIR", tmp_path)
    monkeypatch.delenv("OPENCODE_GO_API_KEY", raising=False)
    monkeypatch.delenv("OPENCODE_GO_MODEL", raising=False)
    assert load_settings().api_key == "from-file"
    assert load_settings().model == "deepseek-v4.1-flash"
    monkeypatch.setenv("OPENCODE_GO_API_KEY", "from-environment")
    assert load_settings().api_key == "from-environment"
    assert "from-environment" not in repr(load_settings())


@pytest.mark.parametrize("model", [
    "unknown-model", "deepseek-v4.1-flash-free", "deepseek-v4-pro",
    "opencode-go/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash",
    "xingchen-agi/xing4.0-29b-a4b:free", "liquid/lfm-2.5-2.6b:free",
])
def test_unsupported_model_is_rejected(model):
    with pytest.raises(ValueError):
        Settings(model=model)


def test_old_provider_credentials_are_not_reused(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text(
        "OPENROUTER_API_KEY=old-provider-secret\nOPENROUTER_MODEL=old-model\n"
    )
    monkeypatch.setattr("app.config.ROOT_DIR", tmp_path)
    monkeypatch.delenv("OPENCODE_GO_API_KEY", raising=False)
    monkeypatch.delenv("OPENCODE_GO_MODEL", raising=False)
    settings = load_settings()
    assert settings.api_key == ""
    assert settings.model == "deepseek-v4.1-flash"


def test_independent_questions_have_distinct_go_session_ids():
    session_ids = []

    def handler(request):
        session_ids.append(request.headers["x-opencode-session"])
        return httpx.Response(200, json=completion())

    with make_client(handler) as client:
        for question in ("Первый вопрос", "Второй вопрос"):
            assert client.post("/api/ask", json={"question": question}).status_code == 200
    assert len(set(session_ids)) == 2
    assert all(UUID(session_id).version == 4 for session_id in session_ids)


@pytest.mark.parametrize("finish_reason", [
    "content_filter", "insufficient_system_resource", "aborted", "tool_calls", "unknown",
])
def test_incomplete_generations_do_not_return_valid_looking_partial_json(finish_reason):
    body = completion("Partial answer test-secret", finish_reason)
    with make_client(lambda request: httpx.Response(200, json=body)) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502
    assert "answer" not in response.json()
    assert "test-secret" not in response.text


def test_unsupported_schema_never_falls_back_to_json_mode_or_another_endpoint():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(400, json={"error": {"message": "Unsupported schema test-secret"}})

    with make_client(handler) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502
    assert "JSON Schema" in response.json()["detail"]
    assert "test-secret" not in response.text
    assert len(requests) == 1
    assert str(requests[0].url) == "https://opencode.ai/inference/go/openai/v1/chat/completions"
    assert json.loads(requests[0].content)["response_format"]["json_schema"]["strict"] is True


def test_go_access_error_explains_deepseek_privacy_settings():
    with make_client(lambda request: httpx.Response(403, json={"error": "test-secret"})) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 503
    assert "Global" in response.json()["detail"]
    assert "подписку" in response.json()["detail"]
    assert "test-secret" not in response.text


def test_go_global_region_requirement_is_not_reported_as_invalid_generation_parameters():
    body = {"error": {
        "message": "Upstream request failed: This Go model requires Global regions. test-secret",
        "type": "server_error",
    }}
    with make_client(lambda request: httpx.Response(400, json=body)) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 503
    assert "Settings → Privacy → Regions" in response.json()["detail"]
    assert "выберите Global" in response.json()["detail"]
    assert "параметры генерации" not in response.json()["detail"]
    assert "test-secret" not in response.text


@pytest.mark.parametrize("model", ALLOWED_MODELS)
def test_supported_models_use_only_go_endpoint(model):
    calls = []

    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        assert payload["model"] == model
        assert str(request.url) == "https://opencode.ai/inference/go/openai/v1/chat/completions"
        assert payload["thinking"] == {"type": "disabled"}
        assert payload["max_tokens"] == 50
        assert payload["stop"] == ["<END_OF_ANSWER>"]
        assert payload["response_format"]["json_schema"]["strict"] is True
        assert "provider" not in payload
        assert "reasoning" not in payload
        return httpx.Response(200, json=completion())

    with make_client(handler, model=model) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 200
    assert response.json()["answer"] == "Привет!"
    assert len(calls) == 1


def test_no_model_fallback_after_provider_failure():
    calls = []

    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(404, json={"error": "Unavailable"})

    with make_client(handler) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502
    assert "OPENCODE_GO_MODEL" in response.json()["detail"]
    assert len(calls) == 1


def test_env_is_not_public(tmp_path, monkeypatch):
    dist = tmp_path / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<h1>Challenge</h1>")
    (tmp_path / ".env").write_text("OPENCODE_GO_API_KEY=test-secret")
    monkeypatch.setattr("app.main.ROOT_DIR", tmp_path)
    with make_client(lambda request: httpx.Response(200, json=completion())) as client:
        assert client.get("/").status_code == 200
        for path in ("/.env", "/backend/app/config.py", "/%2e%2e/.env"):
            response = client.get(path)
            assert response.status_code == 404
            assert "test-secret" not in response.text

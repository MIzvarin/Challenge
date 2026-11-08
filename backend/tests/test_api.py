import json
from datetime import UTC, datetime
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter, ValidationError

from app.config import ALLOWED_MODELS, Settings, load_settings
from app.main import RateLimiter, create_app
from app.solver import LANGUAGE_INSTRUCTION
from app.schemas import AskQuestion, TemperatureQuestion


@pytest.mark.parametrize("temperature", [0, 0.0, 0.7, 1.2])
def test_temperature_question_schema(temperature):
    question = TypeAdapter(AskQuestion).validate_python({"question": "  Привет  ", "temperature": temperature})
    assert isinstance(question, TemperatureQuestion)
    assert question.question == "Привет"
    assert question.temperature == temperature
    assert question.mode == "direct"
    assert not hasattr(question, "effort")


@pytest.mark.parametrize("temperature", [0, 0.7, 1.2])
def test_temperature_direct_uses_shared_generation_path(temperature):
    calls = []
    history = [{"role": "user", "content": "Раньше"}, {"role": "assistant", "content": "Ответ"}]

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        assert set(body) == {"model", "messages", "thinking", "temperature", "stream"}
        assert body["thinking"] == {"type": "disabled"}
        assert body["temperature"] == temperature
        assert body["stream"] is False
        assert body["messages"] == [
            {"role": "system", "content": LANGUAGE_INSTRUCTION}, *history,
            {"role": "user", "content": "Привет"},
        ]
        return httpx.Response(200, json=completion())

    with make_client(handler) as client:
        response = client.post("/api/ask", json={
            "question": "Привет", "temperature": temperature, "history": {"direct": history},
        })
    assert response.status_code == 200
    assert len(calls) == 1
    assert response.json()["temperature"] == temperature
    assert response.json()["effort"] is None


@pytest.mark.parametrize("changes", [
    {"temperature": value} for value in ("0.7", False, True, None, -1, 0.5, 2)
] + [
    {"temperature": 0.7, "effort": value} for value in ("low", "max", None)
] + [
    {"temperature": 0.7, "mode": mode} for mode in ("steps", "prompt", "roles", "compare")
] + [
    {"temperature": 0.7, "thinking": {"type": "enabled"}},
    {"temperature": 0.7, "history": {"roles": []}},
    {"temperature": 0.7, "history": {"direct": [{"role": "user", "content": "Hi"}]}},
])
def test_invalid_temperature_request_never_calls_provider(changes):
    def handler(request):
        pytest.fail("Invalid input must not reach provider")

    with make_client(handler) as client:
        response = client.post("/api/ask", json={"question": "Привет", **changes})
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)


@pytest.mark.parametrize("temperature", [float("nan"), float("inf"), float("-inf")])
def test_nonfinite_temperature_is_rejected(temperature):
    with pytest.raises(ValidationError):
        TypeAdapter(AskQuestion).validate_python({"question": "Hi", "temperature": temperature})


def make_client(handler, api_key="test-secret", model=ALLOWED_MODELS[0]):
    return TestClient(
        create_app(Settings(api_key=api_key, model=model), transport=httpx.MockTransport(handler))
    )


def completion(answer="Привет!", finish_reason="stop", tokens=142):
    return {
        "choices": [{
            "message": {"content": answer},
            "finish_reason": finish_reason,
        }],
        "usage": {"total_tokens": tokens},
    }


def test_question_is_sent_with_server_key():
    def handler(request):
        assert str(request.url) == "https://opencode.ai/inference/go/openai/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer test-secret"
        assert request.headers["user-agent"] == "challenge-qa/0.1"
        assert UUID(request.headers["x-opencode-session"]).version == 5
        payload = json.loads(request.content)
        assert payload["model"] == "deepseek-v4.1-flash"
        assert payload["messages"][-1] == {"role": "user", "content": "Привет"}
        assert payload["messages"] == [
            {"role": "system", "content": LANGUAGE_INSTRUCTION},
            {"role": "user", "content": "Привет"},
        ]
        assert payload["thinking"] == {"type": "enabled"}
        assert payload["reasoning_effort"] == "low"
        assert set(payload) == {
            "model", "messages", "thinking", "reasoning_effort", "stream",
        }
        assert payload["stream"] is False
        return httpx.Response(200, json=completion())

    before = datetime.now(UTC)
    with make_client(handler) as client:
        response = client.post("/api/ask", json={"question": "  Привет  "})
    assert response.status_code == 200
    result = response.json()
    assert result["question"] == "Привет"
    assert result["mode"] == "direct"
    assert result["effort"] == "low"
    assert result["tokens"] == 142
    assert len(result["results"]) == 1
    answer = result["results"][0]
    assert answer == {
        "mode": "direct", "answer": "Привет!", "tokens": 142, "cost": None,
        "duration_ms": answer["duration_ms"], "stages": [], "error": None,
    }
    assert answer["duration_ms"] >= 0
    date = datetime.fromisoformat(result["date"])
    assert date.utcoffset().total_seconds() == 0
    assert before <= date <= datetime.now(UTC)
    assert response.headers["cache-control"] == "no-store"
    assert "test-secret" not in response.text


@pytest.mark.parametrize("payload", [
    {}, {"question": ""}, {"question": " \n "},
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


def test_truncated_answer_is_rejected_even_if_content_is_nonempty():
    with make_client(lambda request: httpx.Response(200, json=completion("Часть", "length"))) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502
    assert "ограничения провайдера" in response.json()["detail"]
    assert "answer" not in response.json()


@pytest.mark.parametrize("content", [123, True, [], {}, {"answer": "test-secret"}])
def test_model_output_must_be_text(content):
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
    question = "В" * 20000
    body = completion("  Краткий ответ.  ", tokens=1800)
    def handler(request):
        assert json.loads(request.content)["messages"][-1]["content"] == question
        return httpx.Response(200, json=body)

    with make_client(handler) as client:
        response = client.post("/api/ask", json={"question": question})
    assert response.status_code == 200
    result = response.json()
    assert result["question"] == question
    assert result["tokens"] == 1800
    assert result["results"][0]["answer"] == "Краткий ответ."


def test_api_response_schema_forbids_extra_fields_and_requires_metadata():
    with make_client(lambda request: httpx.Response(200, json=completion())) as client:
        document = client.get("/openapi.json").json()
        schema = document["components"]["schemas"]["Answer"]
    assert schema["additionalProperties"] is False
    assert schema["required"] == ["question", "date", "mode", "effort", "tokens", "cost", "results"]
    assert schema["properties"]["date"]["format"] == "date-time"
    assert schema["properties"]["tokens"]["anyOf"][0] == {"type": "integer", "minimum": 0}
    temperature_schema = document["components"]["schemas"]["TemperatureAnswer"]
    assert temperature_schema["additionalProperties"] is False
    assert temperature_schema["properties"]["effort"]["type"] == "null"
    assert "temperature" in temperature_schema["required"]
    assert temperature_schema["properties"]["temperature"]["enum"] == [0, 0.7, 1.2]
    assert len(document["paths"]["/api/ask"]["post"]["responses"]["200"]["content"]["application/json"]["schema"]["anyOf"]) == 2


@pytest.mark.parametrize("settings", [{}, {"effort": "max"}, {"temperature": 0}])
def test_response_preserves_envelope_and_reports_real_settings(settings):
    with make_client(lambda request: httpx.Response(200, json=completion(tokens=0))) as client:
        before = datetime.now(UTC)
        response = client.post("/api/ask", json={"question": "Привет", **settings})
    data = response.json()
    keys = {"question", "date", "mode", "effort", "tokens", "cost", "results"}
    assert set(data) == (keys | {"temperature"} if "temperature" in settings else keys)
    assert data["effort"] == (None if "temperature" in settings else settings.get("effort", "low"))
    assert data["tokens"] == 0
    assert before <= datetime.fromisoformat(data["date"]) <= datetime.now(UTC)
    assert set(data["results"][0]) == {"mode", "answer", "tokens", "cost", "duration_ms", "stages", "error"}
    assert data["results"][0]["stages"] == []
    assert data["results"][0]["duration_ms"] >= 0


@pytest.mark.parametrize("failure, status", [
    (httpx.Response(400, json={"error": {"message": "bad parameters"}}), 502),
    (httpx.Response(429, json={"error": {"message": "private"}}), 429),
    (httpx.Response(200, json=completion(finish_reason="length")), 502),
    (httpx.Response(200, json={"choices": completion()["choices"]}), 502),
    (httpx.ReadTimeout("private"), 504),
])
def test_temperature_failures_use_shared_errors_without_retry(failure, status):
    calls = []

    def handler(request):
        calls.append(json.loads(request.content))
        if isinstance(failure, Exception):
            raise failure
        return failure

    with make_client(handler) as client:
        response = client.post("/api/ask", json={"question": "Привет", "temperature": 1.2})
    assert response.status_code == status
    assert len(calls) == 1
    assert calls[0]["thinking"] == {"type": "disabled"}
    assert "private" not in response.text


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
    assert "ограничения провайдера" in response.json()["detail"]
    assert "Попробуйте ещё раз" not in response.json()["detail"]


def test_length_response_without_message_explains_exhausted_budget():
    body = {"choices": [{"finish_reason": "length"}]}
    with make_client(lambda request: httpx.Response(200, json=body)) as client:
        response = client.post("/api/ask", json={"question": "Сложный вопрос"})
    assert response.status_code == 502
    assert "ограничения провайдера" in response.json()["detail"]


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
    assert all(UUID(session_id).version == 5 for session_id in session_ids)


@pytest.mark.parametrize("finish_reason", [
    "content_filter", "insufficient_system_resource", "aborted", "tool_calls", "unknown",
])
def test_incomplete_generations_do_not_return_valid_looking_partial_text(finish_reason):
    body = completion("Partial answer test-secret", finish_reason)
    with make_client(lambda request: httpx.Response(200, json=body)) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502
    assert "answer" not in response.json()
    assert "test-secret" not in response.text


def test_invalid_generation_parameters_never_fall_back_to_another_endpoint():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(400, json={"error": {"message": "Unsupported schema test-secret"}})

    with make_client(handler) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 502
    assert "параметры генерации" in response.json()["detail"]
    assert "test-secret" not in response.text
    assert len(requests) == 1
    assert str(requests[0].url) == "https://opencode.ai/inference/go/openai/v1/chat/completions"
    assert "response_format" not in json.loads(requests[0].content)


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
        assert payload["thinking"] == {"type": "enabled"}
        assert payload["reasoning_effort"] == "low"
        assert "max_tokens" not in payload
        assert "max_completion_tokens" not in payload
        assert "stop" not in payload
        assert "response_format" not in payload
        assert "provider" not in payload
        assert "reasoning" not in payload
        return httpx.Response(200, json=completion())

    with make_client(handler, model=model) as client:
        response = client.post("/api/ask", json={"question": "Привет"})
    assert response.status_code == 200
    assert response.json()["results"][0]["answer"] == "Привет!"
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

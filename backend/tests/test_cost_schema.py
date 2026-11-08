import pytest
from pydantic import ValidationError

from app.schemas import Cost, Stage
from test_api import make_client
import httpx


def valid_cost():
    return {"amount": "0.001446", "currency": "USD", "pricing_version": "v1", "source": "https://opencode.ai/docs/go/"}


@pytest.mark.parametrize("change", [
    {"amount": -1}, {"amount": "-1"}, {"amount": "NaN"}, {"amount": "1e-6"},
    {"amount": "01"}, {"amount": "1\n"}, {"amount": True}, {"currency": "EUR"},
    {"source": "javascript:alert(1)"}, {"source": "http://example.com"},
    {"source": "https:///"}, {"pricing_version": " "}, {"extra": True},
])
def test_cost_rejects_invalid_fields(change):
    with pytest.raises(ValidationError):
        Cost.model_validate({**valid_cost(), **change})


def test_cost_is_required_but_nullable():
    with pytest.raises(ValidationError):
        Stage(name="prompt", content="Текст", tokens=0)
    assert Stage(name="prompt", content="Текст", tokens=0, cost=None).cost is None
    assert Cost.model_validate(valid_cost()).amount == "0.001446"


@pytest.mark.parametrize("path,payload", [
    ("/api/ask", {}), ("/api/ask", {"temperature": 0}),
    ("/api/ask-models", {"model": "kimi-k2.7-code"}),
])
@pytest.mark.parametrize("field", ["cost", "pricing"])
def test_client_cannot_set_price(path, payload, field):
    with make_client(lambda request: pytest.fail("Must not call Go")) as client:
        assert client.post(path, json={"question": "Привет", **payload, field: valid_cost()}).status_code == 422


@pytest.mark.parametrize("path,payload", [
    ("/api/ask", {"effort": "max"}), ("/api/ask", {"temperature": 0}),
    *[("/api/ask-models", {"model": model}) for model in ("kimi-k2.7-code", "grok-4.7", "gpt-6-luna")],
])
@pytest.mark.parametrize("counts", [None, (0, 0, 0), (1000, 200, 400)])
def test_all_api_families_known_unknown_and_zero_cost(path, payload, counts):
    calls = []

    def handler(request):
        calls.append(request)
        usage = {"total_tokens": 0 if counts is None else counts[0] + counts[1]}
        if counts is not None:
            incoming, outgoing, cached = counts
            usage["opencode"] = {"tokens": {"input": incoming - cached, "output": outgoing,
                "cache_read": cached, "cache_write_5m": 0, "cache_write_1h": 0}}
        if request.url.path.endswith("/responses"):
            return httpx.Response(200, json={"status": "completed", "output": [{"type": "message",
                "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "Ответ"}]}], "usage": usage})
        return httpx.Response(200, json={"choices": [{"message": {"content": "Ответ"}, "finish_reason": "stop"}], "usage": usage})

    with make_client(handler) as client:
        response = client.post(path, json={"question": "Привет", **payload})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    cost = body["cost"]
    assert cost == body["results"][0]["cost"]
    if counts is None:
        assert cost is None
    else:
        from decimal import Decimal
        assert (Decimal(cost["amount"]) == 0) == (counts == (0, 0, 0))
        assert cost["currency"] == "USD"
        if payload.get("model") == "kimi-k2.7-code" and counts[0]:
            assert Decimal(cost["amount"]) == Decimal("0.001446")
    assert len(calls) == 1


def test_openapi_cost_required_everywhere():
    with make_client(lambda request: pytest.fail("No inference")) as client:
        schemas = client.get("/openapi.json").json()["components"]["schemas"]
    for name in ("Answer", "TemperatureAnswer", "ModelAnswer", "Result", "Stage"):
        assert "cost" in schemas[name]["required"]
        assert {"type": "null"} in schemas[name]["properties"]["cost"]["anyOf"]
    assert schemas["Cost"]["additionalProperties"] is False

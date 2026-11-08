import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field

from .config import Settings
from .opencode_go import USER_AGENT, _error_status, _provider_error


class Usage(BaseModel):
    total_tokens: int = Field(strict=True, ge=0)


def parse_response(body: object) -> tuple[str, int]:
    try:
        if not isinstance(body, dict) or body.get("status") != "completed":
            raise ValueError()
        if body.get("error") is not None or body.get("incomplete_details") is not None:
            raise ValueError()
        output = body.get("output")
        if not isinstance(output, list):
            raise ValueError()
        texts = []
        for item in output:
            if not isinstance(item, dict) or item.get("error") is not None:
                raise ValueError()
            if item.get("type") == "reasoning":
                continue
            if (item.get("type") != "message" or item.get("role") != "assistant"
                    or item.get("status") != "completed" or not isinstance(item.get("content"), list)):
                raise ValueError()
            for part in item["content"]:
                if (not isinstance(part, dict) or part.get("type") != "output_text"
                        or not isinstance(part.get("text"), str) or part.get("error") is not None):
                    raise ValueError()
                texts.append(part["text"])
        answer = "".join(texts).strip()
        if not answer:
            raise ValueError()
        usage = Usage.model_validate(body.get("usage"))
    except (ValueError, TypeError):
        raise HTTPException(502, "Модель не вернула завершённый ответ с достоверным расходом токенов. Попробуйте ещё раз.") from None
    return answer, usage.total_tokens


async def complete_responses(
    messages: list[dict[str, str]], settings: Settings,
    client: httpx.AsyncClient, session_id: str, *, model: str,
) -> tuple[str, int]:
    try:
        response = await client.post(
            "responses",
            headers={
                "Authorization": f"Bearer {settings.api_key}",
                "User-Agent": USER_AGENT,
                "x-opencode-session": session_id,
            },
            json={
                "model": model, "stream": False, "store": False,
                "instructions": "\n\n".join(m["content"] for m in messages if m["role"] == "system"),
                "input": [m for m in messages if m["role"] != "system"],
            },
        )
    except httpx.TimeoutException:
        raise HTTPException(504, "Модель не успела ответить. Попробуйте ещё раз.") from None
    except httpx.RequestError:
        raise HTTPException(502, "Не удалось связаться с OpenCode Go. Попробуйте позже.") from None

    try:
        body = response.json()
    except ValueError:
        body = None
    error = body.get("error") if isinstance(body, dict) else None
    if response.status_code != 200 or error is not None:
        status = response.status_code if response.status_code != 200 else _error_status(error)
        raise _provider_error(status, response, error, generic=True)
    return parse_response(body)

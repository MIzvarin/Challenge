import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field

from .config import Settings

API_BASE_URL = "https://opencode.ai/inference/go/openai/v1/"
USER_AGENT = "challenge-qa/0.1"


class CompletionUsage(BaseModel):
    total_tokens: int = Field(strict=True, ge=0)


class CompletionMessage(BaseModel):
    content: str | None = None


class CompletionChoice(BaseModel):
    message: CompletionMessage | None = None
    finish_reason: str


class Completion(BaseModel):
    choices: list[CompletionChoice]
    usage: CompletionUsage | None = None


def _error_status(error: object) -> int:
    code = error.get("code") if isinstance(error, dict) else None
    return code if type(code) is int and 400 <= code <= 599 else 502


def _provider_error(status_code: int, response: httpx.Response, error: object = None, *, generic: bool = False) -> HTTPException:
    # HTTP errors and errors embedded in a 200 response share the same safe messages.
    # Never forward raw error messages, metadata or partial output to the browser.
    if generic and status_code in (400, 403, 404):
        message = error.get("message") if isinstance(error, dict) else None
        if status_code == 403 or (status_code == 400 and isinstance(message, str) and "This Go model requires Global regions." in message):
            return HTTPException(503, "OpenCode Go отклонил доступ к выбранной модели. Проверьте подписку, права ключа и разрешённые регионы в Console.")
        return HTTPException(502, "OpenCode Go отклонил запрос выбранной модели. Проверьте её доступность и параметры в Console.")
    if status_code == 429:
        retry_after = response.headers.get("retry-after", "")
        headers = {"Retry-After": retry_after} if retry_after.isascii() and retry_after.isdigit() else None
        if generic:
            detail = "OpenCode Go ограничил запросы. Проверьте лимиты выбранной модели в Console."
        else:
            detail = (
                "OpenCode Go ограничил запросы. Попробуйте позже и проверьте лимиты "
                "подписки и провайдера DeepSeek в OpenCode Console."
            )
        return HTTPException(429, detail, headers=headers)
    if status_code == 401:
        return HTTPException(503, "OpenCode Go отклонил API-ключ. Проверьте OPENCODE_GO_API_KEY в .env.")
    if status_code == 403:
        return HTTPException(
            503,
            "OpenCode Go отклонил доступ. Проверьте подписку, права ключа, допустимость "
            "использования Go этим клиентом и Settings → Privacy → Regions: Global для DeepSeek.",
        )
    if status_code == 402:
        return HTTPException(503, "OpenCode Go отклонил запрос из-за подписки или лимита. Проверьте доступный объём Go в OpenCode Console.")
    if status_code == 400:
        message = error.get("message") if isinstance(error, dict) else None
        if isinstance(message, str) and "This Go model requires Global regions." in message:
            return HTTPException(
                503,
                "Для DeepSeek в OpenCode Go нужно разрешить регион Global. "
                "Откройте OpenCode Console → ваш workspace → Settings → Privacy → Regions "
                "и выберите Global. API-ключ менять не требуется.",
            )
        return HTTPException(502, "OpenCode Go отклонил параметры генерации. Проверьте настройки модели DeepSeek.")
    if status_code == 404:
        return HTTPException(
            502,
            "Модель DeepSeek недоступна в OpenCode Go. Проверьте OPENCODE_GO_MODEL "
            "в .env и доступность модели в OpenCode Console. Автоматической замены модели нет.",
        )
    if status_code in (408, 504, 524):
        return HTTPException(504, "Модель не успела ответить. Попробуйте ещё раз.")
    return HTTPException(502, "OpenCode Go не смог обработать запрос. Попробуйте позже.")


def _parse_generated_answer(choice: CompletionChoice) -> str:
    if choice.finish_reason == "length":
        raise HTTPException(
            502,
            "Модель достигла ограничения провайдера, не завершив ответ. "
            "Приложение не ограничивает число токенов. Попробуйте разбить задачу на части.",
        )
    if choice.finish_reason != "stop":
        raise HTTPException(502, "Модель не завершила ответ. Попробуйте ещё раз.")

    content = choice.message.content if choice.message else None
    answer = (content or "").strip()
    if not answer:
        raise HTTPException(502, "Модель вернула пустой или некорректный ответ. Попробуйте ещё раз.")
    return answer


async def complete(
    messages: list[dict[str, str]],
    settings: Settings,
    client: httpx.AsyncClient,
    session_id: str,
    generation_parameters: dict[str, object],
    *,
    model: str | None = None,
) -> tuple[str, int]:
    try:
        response = await client.post(
            "chat/completions",
            headers={
                "Authorization": f"Bearer {settings.api_key}",
                "User-Agent": USER_AGENT,
                # Stages share a session; conversation context is always sent explicitly.
                "x-opencode-session": session_id,
            },
            json={
                "model": settings.model if model is None else model,
                "messages": messages,
                # Use DeepSeek's native switch, not OpenRouter's reasoning object.
                **generation_parameters,
                "stream": False,
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
    if response.status_code != 200:
        raise _provider_error(response.status_code, response, error, generic=model is not None)
    if error is not None:
        raise _provider_error(_error_status(error), response, error, generic=model is not None)

    # A provider can report a generation failure alongside partial text even
    # with stream=false and HTTP 200. Check it before validating the answer.
    choices = body.get("choices") if isinstance(body, dict) else None
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        choice_error = choices[0].get("error")
        if choice_error is not None or choices[0].get("finish_reason") == "error":
            raise _provider_error(_error_status(choice_error), response, choice_error, generic=model is not None)

    try:
        completion = Completion.model_validate(body)
        choice = completion.choices[0]
    except (ValueError, TypeError, IndexError):
        raise HTTPException(502, "Модель вернула пустой или некорректный ответ. Попробуйте ещё раз.") from None

    answer = _parse_generated_answer(choice)
    if completion.usage is None:
        raise HTTPException(502, "OpenCode Go не вернул статистику расхода токенов. Попробуйте ещё раз.")

    return answer, completion.usage.total_tokens

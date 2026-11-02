import httpx
from fastapi import HTTPException
from pydantic import BaseModel

from .config import Settings


class CompletionMessage(BaseModel):
    content: str | None = None


class CompletionChoice(BaseModel):
    message: CompletionMessage | None = None
    finish_reason: str


class Completion(BaseModel):
    choices: list[CompletionChoice]


class Answer(BaseModel):
    answer: str
    model: str
    truncated: bool = False


def _error_status(error: object) -> int:
    code = error.get("code") if isinstance(error, dict) else None
    return code if type(code) is int and 400 <= code <= 599 else 502


def _provider_error(status_code: int, error: object, response: httpx.Response) -> HTTPException:
    # HTTP errors and errors embedded in a 200 response share the same safe messages.
    # Never forward raw error messages, metadata or partial output to the browser.
    if status_code == 429:
        retry_after = response.headers.get("retry-after", "")
        headers = {"Retry-After": retry_after} if retry_after.isascii() and retry_after.isdigit() else None
        metadata = error.get("metadata") if isinstance(error, dict) else None
        provider_name = metadata.get("provider_name") if isinstance(metadata, dict) else None
        detail = (
            "Провайдер выбранной модели ограничил запросы. Попробуйте позже или выберите "
            "другую бесплатную модель; общая квота OpenRouter может быть не исчерпана."
            if isinstance(provider_name, str) and provider_name.strip()
            else "OpenRouter ограничил запросы. Это может быть минутный или суточный лимит; "
            "проверьте квоту в кабинете OpenRouter."
        )
        return HTTPException(429, detail, headers=headers)
    if status_code in (401, 403):
        return HTTPException(503, "OpenRouter отклонил доступ. Проверьте API-ключ, настройки доступа и ограничения региона.")
    if status_code == 402:
        return HTTPException(503, "OpenRouter отклонил запрос из-за баланса или лимита ключа. Проверьте настройки аккаунта; платная модель не подключалась.")
    if status_code == 404:
        return HTTPException(502, "Бесплатная модель недоступна. Выберите другую разрешённую OPENROUTER_MODEL в .env и перезапустите сервер.")
    if status_code in (408, 504, 524):
        return HTTPException(504, "Модель не успела ответить. Попробуйте ещё раз.")
    return HTTPException(502, "OpenRouter не смог обработать запрос. Попробуйте позже.")


async def ask_openrouter(question: str, settings: Settings, client: httpx.AsyncClient) -> Answer:
    try:
        response = await client.post(
            "/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.api_key}"},
            json={
                "model": settings.model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "Ты полезный помощник. Отвечай понятно и по существу, "
                            "на языке пользователя, если он не попросил другой."
                        ),
                    },
                    {"role": "user", "content": question},
                ],
                "max_completion_tokens": 2048,
                # Both allowed models support disabling thinking. Reserve the
                # small output budget for the visible answer in this simple UI.
                "reasoning": {"enabled": False},
                # Keep routing free even if endpoint prices change.
                "provider": {
                    "max_price": {"prompt": "0", "completion": "0", "request": "0"},
                },
                "stream": False,
            },
        )
    except httpx.TimeoutException:
        raise HTTPException(504, "Модель не успела ответить. Попробуйте ещё раз.") from None
    except httpx.RequestError:
        raise HTTPException(502, "Не удалось связаться с OpenRouter. Попробуйте позже.") from None

    try:
        body = response.json()
    except ValueError:
        body = None

    error = body.get("error") if isinstance(body, dict) else None
    if response.status_code != 200:
        raise _provider_error(response.status_code, error, response)
    if error is not None:
        raise _provider_error(_error_status(error), error, response)

    # OpenRouter can report a generation failure alongside partial text even
    # with stream=false and HTTP 200. Check it before validating the answer.
    choices = body.get("choices") if isinstance(body, dict) else None
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        choice_error = choices[0].get("error")
        if choice_error is not None or choices[0].get("finish_reason") == "error":
            raise _provider_error(_error_status(choice_error), choice_error, response)

    try:
        completion = Completion.model_validate(body)
        choice = completion.choices[0]
    except (ValueError, TypeError, IndexError):
        raise HTTPException(502, "Модель вернула пустой или некорректный ответ. Попробуйте ещё раз.") from None

    answer = (choice.message.content or "").strip() if choice.message else ""
    if not answer:
        if choice.finish_reason == "length":
            raise HTTPException(
                502,
                "Модель исчерпала лимит генерации, не сформировав текст ответа. "
                "Сократите вопрос или выберите другую модель.",
            )
        raise HTTPException(502, "Модель вернула пустой или некорректный ответ. Попробуйте ещё раз.")

    return Answer(answer=answer, model=settings.model, truncated=choice.finish_reason == "length")

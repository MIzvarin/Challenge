from datetime import UTC, datetime
from uuid import uuid4

import httpx
from fastapi import HTTPException
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from .config import Settings

API_BASE_URL = "https://opencode.ai/inference/go/openai/v1/"
USER_AGENT = "challenge-qa/0.1"
MAX_TOKENS = 50
STOP_SEQUENCE = "<END_OF_ANSWER>"


class GeneratedAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    answer: str = Field(min_length=1, description="Краткий ответ на вопрос пользователя.")


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


class Answer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    question: str = Field(min_length=1, max_length=4000)
    date: AwareDatetime
    tokens: int = Field(ge=0)
    answer: str = Field(min_length=1)


def _error_status(error: object) -> int:
    code = error.get("code") if isinstance(error, dict) else None
    return code if type(code) is int and 400 <= code <= 599 else 502


def _provider_error(status_code: int, response: httpx.Response, error: object = None) -> HTTPException:
    # HTTP errors and errors embedded in a 200 response share the same safe messages.
    # Never forward raw error messages, metadata or partial output to the browser.
    if status_code == 429:
        retry_after = response.headers.get("retry-after", "")
        headers = {"Retry-After": retry_after} if retry_after.isascii() and retry_after.isdigit() else None
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
        return HTTPException(502, "OpenCode Go отклонил параметры генерации. Проверьте поддержку JSON Schema, stop и режима thinking у DeepSeek.")
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
            f"Модель исчерпала лимит генерации ({MAX_TOKENS} токенов), не завершив ответ. "
            "Сократите вопрос или выберите другую модель.",
        )
    if choice.finish_reason != "stop":
        raise HTTPException(502, "Модель не завершила ответ. Попробуйте ещё раз.")

    content = choice.message.content if choice.message else None
    try:
        generated = GeneratedAnswer.model_validate_json((content or "").strip())
    except ValueError:
        raise HTTPException(
            502, "Модель вернула ответ, не соответствующий JSON Schema. Попробуйте ещё раз."
        ) from None

    answer = generated.answer.strip()
    if not answer:
        raise HTTPException(502, "Модель вернула пустой или некорректный ответ. Попробуйте ещё раз.")
    return answer


async def ask_opencode_go(question: str, settings: Settings, client: httpx.AsyncClient) -> Answer:
    try:
        response = await client.post(
            "chat/completions",
            headers={
                "Authorization": f"Bearer {settings.api_key}",
                "User-Agent": USER_AGENT,
                # Each independent question is its own one-request conversation.
                "x-opencode-session": str(uuid4()),
            },
            json={
                "model": settings.model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "Ты полезный помощник. Отвечай кратко и по существу, "
                            "на языке пользователя, если он не попросил другой. "
                            "Верни только JSON-объект с единственным полем answer, без Markdown. "
                            f"Весь JSON должен уложиться в {MAX_TOKENS} токенов: дай ответ в 1–2 коротких "
                            "предложениях и обязательно закрой JSON. "
                            f"Не включай маркер {STOP_SEQUENCE} внутрь JSON."
                        ),
                    },
                    {"role": "user", "content": question},
                ],
                "max_tokens": MAX_TOKENS,
                # Stop on a unique marker, never on JSON punctuation or newlines.
                "stop": [STOP_SEQUENCE],
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "answer",
                        "strict": True,
                        "schema": GeneratedAnswer.model_json_schema(),
                    },
                },
                # Use DeepSeek's native switch, not OpenRouter's reasoning object.
                "thinking": {"type": "disabled"},
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
        raise _provider_error(response.status_code, response, error)
    if error is not None:
        raise _provider_error(_error_status(error), response, error)

    # A provider can report a generation failure alongside partial text even
    # with stream=false and HTTP 200. Check it before validating the answer.
    choices = body.get("choices") if isinstance(body, dict) else None
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        choice_error = choices[0].get("error")
        if choice_error is not None or choices[0].get("finish_reason") == "error":
            raise _provider_error(_error_status(choice_error), response, choice_error)

    try:
        completion = Completion.model_validate(body)
        choice = completion.choices[0]
    except (ValueError, TypeError, IndexError):
        raise HTTPException(502, "Модель вернула пустой или некорректный ответ. Попробуйте ещё раз.") from None

    answer = _parse_generated_answer(choice)
    if completion.usage is None:
        raise HTTPException(502, "OpenCode Go не вернул статистику расхода токенов. Попробуйте ещё раз.")

    # Metadata is authoritative: never ask the model to invent dates or token usage,
    # or spend the output budget echoing a potentially 4,000-char question.
    return Answer(
        question=question,
        date=datetime.now(UTC),
        tokens=completion.usage.total_tokens,
        answer=answer,
    )

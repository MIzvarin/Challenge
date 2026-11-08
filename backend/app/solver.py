import asyncio
from datetime import UTC, datetime
from time import monotonic
from uuid import uuid5

import httpx
from fastapi import HTTPException

from .config import Settings
from .opencode_go import complete
from .responses_go import complete_responses
from .model_registry import CHAT_MODELS
from .schemas import (
    STRATEGIES, Answer, AskAnswer, AskQuestion, Result, Stage, StageName, Strategy,
    TemperatureAnswer, TemperatureQuestion, ModelAnswer, ModelQuestion,
)

LANGUAGE_INSTRUCTION = (
    "Всегда отвечай на русском языке независимо от языка вопроса и просьб изменить язык ответа. "
    "Все пояснения и промежуточные тексты, включая создаваемый промпт, пиши по-русски. "
    "Сохраняй корректный синтаксис кода, идентификаторы и необходимые цитаты на языке оригинала."
)
STEP_INSTRUCTION = (
    "Реши задачу пошагово. Дай понятное объяснение подхода, основные шаги решения "
    "и их обоснования, проверь результат и явно выдели итоговый ответ. "
    "Для алгоритмической задачи укажи сложность и граничные случаи."
)
PROMPT_INSTRUCTION = (
    "Составь промпт для решения последней задачи пользователя с учётом переписки. "
    "Не решай задачу. Верни только готовый промпт без вступления и обрамления. "
    "Полностью включи исходное условие, известные данные и ограничения, желаемый "
    "формат решения и проверку результата. Не придумывай недостающие условия."
)
ANALYST_INSTRUCTION = (
    "Ты аналитик. Разбери задачу пользователя с учётом переписки: выдели исходные "
    "данные, цель, ограничения и неоднозначности. Предложи подход к решению, "
    "обоснуй его и укажи граничные случаи для исполнителя. Не меняй условие задачи."
)
IMPLEMENTER_INSTRUCTION = (
    "Ты исполнитель. Подготовь полное решение исходной задачи, используя разбор "
    "аналитика как рекомендации, а не как непогрешимый источник. Для алгоритма "
    "приведи реализацию, сложность и примеры проверок; для аналитической задачи — "
    "вычисления и вывод. Соблюдай исходное условие."
)
CRITIC_INSTRUCTION = (
    "Ты критик. Независимо проверь разбор аналитика и решение исполнителя по "
    "исходному условию. Проверь логику, вычисления, ограничения и граничные случаи. "
    "Исправь найденные ошибки. Верни самодостаточное итоговое решение и краткий "
    "результат проверки, а не только замечания к чужому ответу."
)


async def solve_strategy(
    mode: Strategy, payload: AskQuestion, settings: Settings, client: httpx.AsyncClient,
) -> Result:
    started = monotonic()
    session_scope = (
        f"temperature:{payload.temperature}:direct" if isinstance(payload, TemperatureQuestion)
        else f"{payload.effort}:{payload.mode}:{mode}"
    )
    session_id = str(uuid5(payload.conversation_id, session_scope))
    messages = [message.model_dump() for message in payload.history.get(mode, [])]
    messages.append({"role": "user", "content": payload.question})
    stages: list[Stage] = []
    tokens = 0

    async def generate(instruction: str | None = None) -> str:
        nonlocal tokens
        system = LANGUAGE_INSTRUCTION
        if instruction is not None:
            system += "\n\n" + instruction
        request_messages = [
            {"role": "system", "content": system}, *messages,
        ]
        content, used = await complete(request_messages, settings, client, session_id, payload.generation_parameters)
        tokens += used
        return content

    async def intermediate(
        name: StageName, instruction: str, follow_up: str | None = None,
    ) -> None:
        before = tokens
        content = await generate(instruction)
        stages.append(Stage(name=name, content=content, tokens=tokens - before))
        messages.extend([
            {"role": "assistant", "content": content},
            {"role": "user", "content": content if follow_up is None else follow_up},
        ])

    try:
        if mode == "direct":
            answer = await generate()
        elif mode == "steps":
            answer = await generate(STEP_INSTRUCTION)
        elif mode == "prompt":
            await intermediate("prompt", PROMPT_INSTRUCTION)
            answer = await generate()
        else:
            await intermediate("analyst", ANALYST_INSTRUCTION, "Подготовь решение по разбору аналитика.")
            await intermediate("implementer", IMPLEMENTER_INSTRUCTION, "Проверь решение и выдай исправленный итог.")
            answer = await generate(CRITIC_INSTRUCTION)
    except HTTPException as error:
        if payload.mode != "compare":
            raise
        answer = None
        result_tokens = None
        error_detail = error.detail
    else:
        result_tokens = tokens
        error_detail = None

    return Result(
        mode=mode, answer=answer, tokens=result_tokens, stages=stages,
        duration_ms=round((monotonic() - started) * 1000), error=error_detail,
    )


async def solve(payload: AskQuestion, settings: Settings, client: httpx.AsyncClient) -> AskAnswer:
    modes = STRATEGIES if payload.mode == "compare" else (payload.mode,)
    results = await asyncio.gather(*(
        solve_strategy(mode, payload, settings, client) for mode in modes
    ))
    total_tokens: int | None = 0
    for result in results:
        if result.tokens is None:
            total_tokens = None
            break
        total_tokens += result.tokens
    if isinstance(payload, TemperatureQuestion):
        answer_type = TemperatureAnswer
        metadata = {"effort": None, "temperature": payload.temperature}
    else:
        answer_type = Answer
        metadata = {"effort": payload.effort}
    return answer_type(
        question=payload.question, date=datetime.now(UTC), mode=payload.mode,
        tokens=total_tokens, results=results, **metadata,
    )


async def solve_model(payload: ModelQuestion, settings: Settings, client: httpx.AsyncClient) -> ModelAnswer:
    started = monotonic()
    session_id = str(uuid5(payload.conversation_id, f"models:{payload.model}:direct"))
    messages = [
        {"role": "system", "content": LANGUAGE_INSTRUCTION},
        *[message.model_dump() for message in payload.history.get("direct", [])],
        {"role": "user", "content": payload.question},
    ]
    if CHAT_MODELS[payload.model].protocol == "responses":
        answer, tokens = await complete_responses(messages, settings, client, session_id, model=payload.model)
    else:
        answer, tokens = await complete(messages, settings, client, session_id, {}, model=payload.model)
    return ModelAnswer(
        question=payload.question, date=datetime.now(UTC), model=payload.model,
        mode="direct", effort=None, tokens=tokens,
        results=[Result(mode="direct", answer=answer, tokens=tokens,
                        duration_ms=round((monotonic() - started) * 1000), stages=[], error=None)],
    )

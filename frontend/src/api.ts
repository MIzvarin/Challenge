export interface Answer {
  question: string;
  date: string;
  tokens: number;
  answer: string;
}

const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isAnswer(data: unknown, question: string): data is Answer {
  if (!data || typeof data !== 'object' || Object.keys(data).length !== 4) return false;

  if (
    !('question' in data) || !('date' in data) || !('tokens' in data) || !('answer' in data)
  ) {
    return false;
  }

  const { question: responseQuestion, date, tokens, answer } = data;

  if (
    typeof responseQuestion !== 'string' || responseQuestion !== question ||
    !responseQuestion.trim() || responseQuestion.length > 4000
  ) {
    return false;
  }

  if (
    typeof date !== 'string' || !ISO_DATETIME_PATTERN.test(date) || !Number.isFinite(Date.parse(date))
  ) {
    return false;
  }

  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
    return false;
  }

  return typeof answer === 'string' && Boolean(answer.trim());
}

export async function askQuestion(question: string, signal: AbortSignal): Promise<Answer> {
  const response = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
    signal,
  });

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('Сервер вернул некорректный ответ. Проверьте, запущен ли бэкенд.');
  }

  if (!response.ok) {
    const detail = data && typeof data === 'object' && 'detail' in data ? data.detail : null;
    throw new Error(typeof detail === 'string' ? detail : 'Не удалось получить ответ. Попробуйте позже.');
  }

  if (!isAnswer(data, question)) {
    throw new Error('Сервер вернул некорректный ответ. Попробуйте ещё раз.');
  }

  return { question: data.question, date: data.date, tokens: data.tokens, answer: data.answer };
}

export interface Answer {
  answer: string;
  model: string;
  truncated: boolean;
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

  if (
    !data || typeof data !== 'object' ||
    !('answer' in data) || typeof data.answer !== 'string' || !data.answer.trim() ||
    !('model' in data) || typeof data.model !== 'string' ||
    !('truncated' in data) || typeof data.truncated !== 'boolean'
  ) {
    throw new Error('Сервер вернул некорректный ответ. Попробуйте ещё раз.');
  }

  return { answer: data.answer, model: data.model, truncated: data.truncated };
}

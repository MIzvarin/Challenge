import { afterEach, expect, it, vi } from 'vitest';
import { askQuestion, isAnswer } from './api';
import type { ModelAnswer } from './api';
import { CHAT_MODELS } from './modes';

export function modelAnswer(model: ModelAnswer['model'] = 'kimi-k2.7-code', question = 'Привет'): ModelAnswer {
  return {
    question, date: '2026-11-08T12:00:00Z', mode: 'direct', effort: null, model, tokens: 0,
    results: [{ mode: 'direct', answer: 'Ответ', tokens: 0, duration_ms: 10, stages: [], error: null }],
  };
}

afterEach(() => vi.unstubAllGlobals());

it.each(CHAT_MODELS)('sends only selected model %s and direct history', async (model) => {
  const response = modelAnswer(model);
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
  vi.stubGlobal('fetch', fetchMock);
  const scope = { workspace: 'models', model, mode: 'direct' } as const;
  const history = { direct: [{ role: 'user', content: 'Раньше' }, { role: 'assistant', content: 'Ответ' }] } as const;
  const signal = new AbortController().signal;
  const mutableHistory = { direct: [...history.direct] };
  expect(await askQuestion('Привет', scope, mutableHistory, signal, 'uuid')).toEqual(response);
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/ask-models', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ question: 'Привет', model, history, conversation_id: 'uuid' }),
  });
});

it.each([
  { model: 'grok-4.7' }, { model: 'beam-free' }, { model: 'gemini-4-argon' }, { model: 'unknown' }, { model: undefined },
  { temperature: 0 }, { effort: 'low' }, { effort: undefined }, { mode: 'compare' },
  { question: 'Подмена' }, { date: 'bad' }, { tokens: -1 }, { tokens: 1.5 }, { tokens: 1 },
  { results: [] }, { results: [modelAnswer().results[0], modelAnswer().results[0]] },
  { results: [{ ...modelAnswer().results[0], stages: [{ name: 'prompt', content: 'x', tokens: 0 }] }] },
  { results: [{ ...modelAnswer().results[0], duration_ms: -1 }] },
  { results: [{ ...modelAnswer().results[0], answer: null, error: 'Ошибка', tokens: null }], tokens: null },
])('rejects inconsistent model response %j', (changes) => {
  expect(isAnswer({ ...modelAnswer(), ...changes }, 'Привет', 'direct', {
    workspace: 'models', model: 'kimi-k2.7-code', mode: 'direct',
  })).toBe(false);
});

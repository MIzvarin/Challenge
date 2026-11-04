import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { askQuestion } from './api';
import { makeAnswer, makeResult } from './test-fixtures';

afterEach(() => vi.unstubAllGlobals());

const result = makeAnswer();

function mockJsonResponse(data: unknown, status = 200): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(data), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function ask() {
  return askQuestion('Привет', 'direct', {}, new AbortController().signal);
}

describe('askQuestion', () => {
  it('sends mode and full history only to the local backend without an API key', async () => {
    const fetchMock = mockJsonResponse(result);
    const signal = new AbortController().signal;
    const history = { direct: [{ role: 'user' as const, content: 'Ранее' }, { role: 'assistant' as const, content: 'Ответ' }] };
    expect(await askQuestion('Привет', 'direct', history, signal)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Привет', mode: 'direct', effort: 'low', history }), signal,
    });
  });

  it('surfaces server error messages', async () => {
    mockJsonResponse({ detail: 'Лимит исчерпан' }, 429);
    await expect(ask()).rejects.toThrow('Лимит исчерпан');
  });

  it('sends the persisted conversation ID to the backend', async () => {
    const fetchMock = mockJsonResponse(result);
    const conversationId = crypto.randomUUID();
    await askQuestion('Привет', 'direct', {}, new AbortController().signal, 'low', conversationId);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).conversation_id).toBe(conversationId);
  });

  it('accepts responses to long questions without a character cap', async () => {
    const question = 'Задача'.repeat(4000);
    const response = makeAnswer(question);
    mockJsonResponse(response);
    expect(await askQuestion(question, 'direct', {}, new AbortController().signal)).toEqual(response);
  });

  it('handles invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Proxy error</html>')));
    await expect(ask()).rejects.toThrow('некорректный ответ');
  });

  it.each([
    null, [], 'Ответ', 142, true, {}, { answer: 'Ответ' },
    { ...result, question: null }, { ...result, date: null },
    { ...result, question: '' }, { ...result, question: 'Подмена' },
    { ...result, date: 'invalid' }, { ...result, date: '2026-11-03' },
    { ...result, date: '2026-11-03T12:30:00' }, { ...result, date: '2026-13-03T12:30:00Z' },
    { ...result, tokens: -1 }, { ...result, tokens: 1.5 }, { ...result, tokens: '142' },
    { ...result, tokens: null }, { ...result, tokens: true },
    { ...result, tokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...result, tokens: 143 },
    { ...result, results: [] }, { ...result, results: null },
    { ...result, results: [makeResult('steps')] },
    { ...result, mode: 'roles' }, { ...result, extra: true },
    { ...result, effort: 'max' }, { ...result, effort: undefined }, { ...result, effort: 'high' },
  ])('rejects responses outside the strict schema: %j', async (data) => {
    mockJsonResponse(data);
    await expect(ask()).rejects.toThrow('некорректный ответ');
  });

  it.each([
    { answer: '' }, { answer: ' ' }, { answer: null }, { error: 'Failure' },
    { tokens: -1 }, { tokens: 141 }, { duration_ms: -1 }, { duration_ms: '1' },
    { stages: [{ name: 'prompt', content: 'Invalid stage', tokens: 0 }] },
    { extra: 'unexpected' },
  ])('rejects invalid strategy results: %j', async (changes) => {
    mockJsonResponse({ ...result, results: [{ ...result.results[0], ...changes }] });
    await expect(ask()).rejects.toThrow('некорректный ответ');
  });

  it('accepts zero token usage reported by the server', async () => {
    mockJsonResponse({ ...result, tokens: 0, results: [{ ...result.results[0], tokens: 0 }] });
    expect((await ask()).tokens).toBe(0);
  });

  it('sends the maximum effort profile and rejects mismatched profiles', async () => {
    const response = makeAnswer('Привет', 'direct', 'max');
    const fetchMock = mockJsonResponse(response);
    const signal = new AbortController().signal;
    expect(await askQuestion('Привет', 'direct', {}, signal, 'max')).toEqual(response);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).effort).toBe('max');
    mockJsonResponse(makeAnswer());
    await expect(askQuestion('Привет', 'direct', {}, signal, 'max')).rejects.toThrow('некорректный ответ');
  });

  it.each(['2026-11-03T12:30:00.123456Z', '2026-11-03T15:30:00+03:00'])(
    'accepts timestamp %s', async (date) => {
      mockJsonResponse({ ...result, date });
      expect((await ask()).date).toBe(date);
    },
  );

  it.each([0, 1, 2, 3])('accepts a comparison failure at index %i without fabricated total usage', async (index) => {
    const response = makeAnswer('Привет', 'compare');
    response.results[index] = { ...response.results[index], answer: null, error: 'Ошибка', tokens: null };
    response.tokens = null;
    mockJsonResponse(response);
    expect(await askQuestion('Привет', 'compare', {}, new AbortController().signal)).toEqual(response);
  });

  it('rejects duplicated or missing comparison strategies', async () => {
    const response = makeAnswer('Привет', 'compare');
    response.results[3] = response.results[0];
    mockJsonResponse(response);
    await expect(askQuestion('Привет', 'compare', {}, new AbortController().signal)).rejects.toThrow('некорректный ответ');
  });

  it.each(['prompt', 'roles'] as const)('requires intermediate stages for successful %s results', async (mode) => {
    const response = makeAnswer('Привет', mode);
    response.results[0].stages = [];
    mockJsonResponse(response);
    await expect(askQuestion('Привет', mode, {}, new AbortController().signal)).rejects.toThrow('некорректный ответ');
  });

  it.each([
    { stages: [{ name: 'implementer', content: 'Реализация', tokens: 10 }] },
    { stages: [{ name: 'analyst', content: ' ', tokens: 10 }] },
    { stages: [{ name: 'analyst', content: 'Разбор', tokens: -1 }] },
    { stages: [{ name: 'analyst', content: 'Разбор', tokens: 10, extra: true }] },
  ])('rejects invalid intermediate stages even in a failed comparison: %j', async ({ stages }) => {
    const response = makeAnswer('Привет', 'compare');
    const results = [...response.results];
    const failed = { ...results[3], answer: null, tokens: null, error: 'Ошибка', stages };
    mockJsonResponse({ ...response, tokens: null, results: [...results.slice(0, 3), failed] });
    await expect(askQuestion('Привет', 'compare', {}, new AbortController().signal)).rejects.toThrow('некорректный ответ');
  });
});

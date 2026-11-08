import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { askQuestion, isAnswer } from './api';
import { makeAnswer, makeCost, makeResult, makeTemperatureAnswer, withCosts } from './test-fixtures';
import type { Effort, Mode, Temperature } from './modes';

const reasoning = (mode: Mode = 'direct', effort: Effort = 'low') => ({ workspace: 'reasoning' as const, mode, effort });
const temperatureScope = (temperature: Temperature) => ({ workspace: 'temperature' as const, mode: 'direct' as const, temperature });

afterEach(() => vi.unstubAllGlobals());

const result = makeAnswer();

function mockJsonResponse(data: unknown, status = 200): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(data), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function ask() {
  return askQuestion('Привет', reasoning(), {}, new AbortController().signal);
}

describe('askQuestion', () => {
  it.each(['direct', 'prompt', 'roles', 'compare'] as const)('validates exact prices for %s', (mode) => {
    const response = withCosts(makeAnswer('Привет', mode));
    expect(isAnswer(response, 'Привет', mode)).toBe(true);
    response.cost!.amount = '0.009';
    expect(isAnswer(response, 'Привет', mode)).toBe(false);
  });

  it.each([
    { amount: '-1' }, { amount: 'NaN' }, { amount: '1e-6' }, { amount: 1 },
    { amount: '0\n' }, { currency: 'EUR' }, { pricing_version: ' ' },
    { source: 'http://example.com' }, { source: 'javascript:alert(1)' }, { extra: true },
  ])('rejects malformed cost at every level: %j', (changes) => {
    for (const level of ['answer', 'result', 'stage']) {
      const response = withCosts(makeAnswer('Привет', 'prompt'));
      const target = level === 'answer' ? response : level === 'result' ? response.results[0] : response.results[0].stages[0];
      Object.assign(target, { cost: { ...makeCost(), ...changes } });
      expect(isAnswer(response, 'Привет', 'prompt')).toBe(false);
    }
  });

  it('requires cost fields in new network responses and matching pricing metadata', () => {
    for (const level of ['answer', 'result', 'stage']) {
      const response = withCosts(makeAnswer('Привет', 'prompt'));
      const target = level === 'answer' ? response : level === 'result' ? response.results[0] : response.results[0].stages[0];
      delete target.cost;
      expect(isAnswer(response, 'Привет', 'prompt')).toBe(false);
    }
    const response = withCosts(makeAnswer('Привет', 'compare'));
    response.results[0].cost!.pricing_version = 'other';
    expect(isAnswer(response, 'Привет', 'compare')).toBe(false);
    response.results[0].cost = null;
    expect(isAnswer(response, 'Привет', 'compare')).toBe(false);
    response.cost = null;
    expect(isAnswer(response, 'Привет', 'compare')).toBe(true);
  });

  it('checks all failed comparison results, not only those before unknown tokens', () => {
    const response = makeAnswer('Привет', 'compare');
    response.results[0] = { ...response.results[0], answer: null, error: 'Ошибка', tokens: null };
    response.tokens = null;
    response.results[3].stages[0].cost = makeCost('-1');
    expect(isAnswer(response, 'Привет', 'compare')).toBe(false);
  });
  it.each([0, 0.7, 1.2] as const)('sends temperature %s without effort', async (temperature) => {
    const response = makeTemperatureAnswer('Привет', temperature);
    const fetchMock = mockJsonResponse(response);
    expect(await askQuestion('Привет', temperatureScope(temperature), {}, new AbortController().signal)).toEqual(response);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({
      question: 'Привет', mode: 'direct', temperature, history: {},
    });
  });

  it.each([
    { temperature: 0.7 }, { temperature: undefined }, { temperature: null }, { temperature: '0' },
    { effort: 'low' }, { effort: undefined }, { extra: true }, { mode: 'compare' },
  ])('rejects incorrect temperature metadata: %j', async (changes) => {
    mockJsonResponse({ ...makeTemperatureAnswer('Привет', 0), ...changes });
    await expect(askQuestion('Привет', temperatureScope(0), {}, new AbortController().signal)).rejects.toThrow('некорректный ответ');
  });

  it('never accepts a response from the other workspace', async () => {
    mockJsonResponse(makeAnswer());
    await expect(askQuestion('Привет', temperatureScope(0), {}, new AbortController().signal)).rejects.toThrow();
    mockJsonResponse(makeTemperatureAnswer());
    await expect(ask()).rejects.toThrow();
  });

  it('sends mode and full history only to the local backend without an API key', async () => {
    const fetchMock = mockJsonResponse(result);
    const signal = new AbortController().signal;
    const history = { direct: [{ role: 'user' as const, content: 'Ранее' }, { role: 'assistant' as const, content: 'Ответ' }] };
    expect(await askQuestion('Привет', reasoning(), history, signal)).toEqual(result);
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
    await askQuestion('Привет', reasoning(), {}, new AbortController().signal, conversationId);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).conversation_id).toBe(conversationId);
  });

  it('accepts responses to long questions without a character cap', async () => {
    const question = 'Задача'.repeat(4000);
    const response = makeAnswer(question);
    mockJsonResponse(response);
    expect(await askQuestion(question, reasoning(), {}, new AbortController().signal)).toEqual(response);
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
    expect(await askQuestion('Привет', reasoning('direct', 'max'), {}, signal)).toEqual(response);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).effort).toBe('max');
    mockJsonResponse(makeAnswer());
    await expect(askQuestion('Привет', reasoning('direct', 'max'), {}, signal)).rejects.toThrow('некорректный ответ');
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
    expect(await askQuestion('Привет', reasoning('compare'), {}, new AbortController().signal)).toEqual(response);
  });

  it('rejects duplicated or missing comparison strategies', async () => {
    const response = makeAnswer('Привет', 'compare');
    response.results[3] = response.results[0];
    mockJsonResponse(response);
    await expect(askQuestion('Привет', reasoning('compare'), {}, new AbortController().signal)).rejects.toThrow('некорректный ответ');
  });

  it.each(['prompt', 'roles'] as const)('requires intermediate stages for successful %s results', async (mode) => {
    const response = makeAnswer('Привет', mode);
    response.results[0].stages = [];
    mockJsonResponse(response);
    await expect(askQuestion('Привет', reasoning(mode), {}, new AbortController().signal)).rejects.toThrow('некорректный ответ');
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
    await expect(askQuestion('Привет', reasoning('compare'), {}, new AbortController().signal)).rejects.toThrow('некорректный ответ');
  });
});

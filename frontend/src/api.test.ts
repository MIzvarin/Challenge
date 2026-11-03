import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { askQuestion } from './api';

afterEach(() => vi.unstubAllGlobals());

const result = { question: 'Привет', date: '2026-11-03T12:30:00Z', tokens: 142, answer: 'Привет!' };

function mockJsonResponse(data: unknown, status = 200): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(data), { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('askQuestion', () => {
  it('uses only the local backend without an API key', async () => {
    const fetchMock = mockJsonResponse(result);
    const signal = new AbortController().signal;
    expect(await askQuestion('Привет', signal)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Привет' }), signal,
    });
  });

  it('surfaces server error messages', async () => {
    mockJsonResponse({ detail: 'Лимит исчерпан' }, 429);
    await expect(askQuestion('Привет', new AbortController().signal)).rejects.toThrow('Лимит исчерпан');
  });

  it('handles invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Proxy error</html>')));
    await expect(askQuestion('Привет', new AbortController().signal)).rejects.toThrow('некорректный ответ');
  });

  it.each([
    null, [], 'Ответ', 142, true,
    {}, { answer: 'Ответ' },
    { ...result, question: null }, { ...result, date: null }, { ...result, answer: null },
    { question: result.question, date: result.date, tokens: result.tokens, extra: 'missing answer' },
    { ...result, question: '' }, { ...result, question: 'Подмена' },
    { ...result, date: 'invalid' }, { ...result, date: '2026-11-03' },
    { ...result, date: '2026-11-03T12:30:00' }, { ...result, date: '2026-13-03T12:30:00Z' },
    { ...result, tokens: -1 }, { ...result, tokens: 1.5 }, { ...result, tokens: '142' },
    { ...result, tokens: null }, { ...result, tokens: true },
    { ...result, tokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...result, answer: '' }, { ...result, answer: '  ' },
    { ...result, model: 'unexpected extra field' },
  ])('rejects responses outside the strict schema: %j', async (data) => {
    mockJsonResponse(data);
    await expect(askQuestion('Привет', new AbortController().signal)).rejects.toThrow('некорректный ответ');
  });

  it('accepts zero token usage reported by the server', async () => {
    mockJsonResponse({ ...result, tokens: 0 });
    expect((await askQuestion('Привет', new AbortController().signal)).tokens).toBe(0);
  });

  it.each([
    '2026-11-03T12:30:00.123456Z',
    '2026-11-03T15:30:00+03:00',
  ])('accepts timestamps with fractional seconds or time zone offsets: %s', async (date) => {
    const response = { ...result, date };
    mockJsonResponse(response);
    expect(await askQuestion('Привет', new AbortController().signal)).toEqual(response);
  });
});

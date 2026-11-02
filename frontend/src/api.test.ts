import { afterEach, describe, expect, it, vi } from 'vitest';
import { askQuestion } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('askQuestion', () => {
  it('uses only the local backend without an API key', async () => {
    const result = { answer: 'Привет!', model: 'test', truncated: false };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    expect(await askQuestion('Привет', signal)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Привет' }), signal,
    });
  });

  it('surfaces server error messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Лимит исчерпан' }), { status: 429 }),
    ));
    await expect(askQuestion('Привет', new AbortController().signal)).rejects.toThrow('Лимит исчерпан');
  });

  it('handles invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Proxy error</html>')));
    await expect(askQuestion('Привет', new AbortController().signal)).rejects.toThrow('некорректный ответ');
  });

  it('validates the response shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ answer: '' }))));
    await expect(askQuestion('Привет', new AbortController().signal)).rejects.toThrow('некорректный ответ');
  });
});

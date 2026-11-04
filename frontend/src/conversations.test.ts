import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHistory, emptyConversations, emptyProfiles, LEGACY_STORAGE_KEY, loadConversations, saveConversations, STORAGE_KEY } from './conversations';
import type { Turn } from './conversations';
import { makeAnswer } from './test-fixtures';

function turn(response = makeAnswer()): Turn {
  return { id: 'turn-1', question: response.question, date: response.date, response, error: null };
}

describe('conversations', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips all conversations', () => {
    const conversations = emptyProfiles();
    conversations.low.direct.push(turn());
    conversations.max.roles.push(turn(makeAnswer('Задача', 'roles', 'max')));
    expect(saveConversations(conversations)).toBeNull();
    expect(loadConversations()).toEqual({ conversations, warning: null });
  });

  it('restores interrupted requests as errors, not permanent loading states', () => {
    const conversations = emptyProfiles();
    conversations.low.direct.push({ ...turn(), response: null });
    saveConversations(conversations);
    expect(loadConversations().conversations.low.direct[0].error).toContain('Запрос прерван');
  });

  it('does not interrupt a pending turn while another browser tab owns its request', () => {
    const conversations = emptyProfiles();
    conversations.low.direct.push({ ...turn(), response: null });
    saveConversations(conversations);
    expect(loadConversations(new Set(['turn-1'])).conversations).toEqual(conversations);
  });

  it('gives each comparison strategy only its own prior answers', () => {
    const response = makeAnswer('Задача', 'compare');
    for (const result of response.results) result.answer = `Ответ ${result.mode}`;
    const history = buildHistory('compare', [turn(response)]);
    for (const mode of ['direct', 'steps', 'prompt', 'roles'] as const) {
      expect(history[mode]![0]).toEqual({ role: 'user', content: 'Задача' });
      expect(history[mode]![1].content).toContain(`Ответ ${mode}`);
      expect(history[mode]![1].content).not.toContain(`Ответ ${mode === 'direct' ? 'steps' : 'direct'}`);
    }
  });

  it('omits unsuccessful strategy answers from follow-up context', () => {
    const response = makeAnswer('Задача', 'compare');
    response.results[0] = { ...response.results[0], answer: null, tokens: null, error: 'Ошибка' };
    response.tokens = null;
    const history = buildHistory('compare', [turn(response)]);
    expect(history.direct).toEqual([]);
    expect(history.roles).toHaveLength(2);
  });

  it('does not trim long histories or omit generated prompts', () => {
    const response = makeAnswer('Задача', 'prompt');
    response.results[0].answer = 'Развёрнутый ответ '.repeat(10000);
    const history = buildHistory('prompt', [turn(response)]).prompt!;
    expect(history[1].content).toContain(response.results[0].answer);
    expect(history[1].content).toContain('Готовый промпт');
  });

  it('rejects invalid saved response metadata', () => {
    const conversations = emptyProfiles();
    conversations.low.direct.push(turn());
    const data = JSON.parse(JSON.stringify(conversations));
    data.low.direct[0].response.tokens = -1;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    expect(loadConversations().warning).not.toBeNull();
  });

  it('migrates pre-effort history into the low profile without fabricating old effort metadata', () => {
    const conversations = emptyConversations();
    const response = makeAnswer();
    delete response.effort;
    conversations.direct.push(turn(response));
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(conversations));
    const restored = loadConversations();
    expect(restored.warning).toBeNull();
    expect(restored.conversations.low).toEqual(conversations);
    expect(restored.conversations.max).toEqual(emptyConversations());
    expect(restored.conversations.low.direct[0].response!.effort).toBeUndefined();
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
    saveConversations(restored.conversations);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(loadConversations().conversations).toEqual(restored.conversations);
  });

  it('rejects saved responses mixed between effort profiles', () => {
    const conversations = emptyProfiles();
    conversations.max.direct.push(turn(makeAnswer()));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    expect(loadConversations().warning).not.toBeNull();
  });

  it('preserves the legacy copy if saving the migrated history fails', () => {
    const conversations = emptyConversations();
    conversations.direct.push(turn());
    const legacy = JSON.stringify(conversations);
    localStorage.setItem(LEGACY_STORAGE_KEY, legacy);
    const restored = loadConversations();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota'); });
    try {
      expect(saveConversations(restored.conversations)).toContain('Не удалось сохранить историю');
      expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBe(legacy);
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves failed turns when restoring history and omits them from model context', () => {
    const conversations = emptyProfiles();
    conversations.low.direct.push({ ...turn(), response: null, error: 'Ошибка запроса' });
    saveConversations(conversations);
    const restored = loadConversations().conversations;
    expect(restored).toEqual(conversations);
    expect(buildHistory('direct', restored.low.direct)).toEqual({ direct: [] });
  });

  it('rejects duplicate turn IDs within one conversation', () => {
    const conversations = emptyProfiles();
    conversations.low.direct.push(turn(), turn());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    expect(loadConversations().warning).not.toBeNull();
  });

  it.each([
    { id: null }, { question: 42 }, { question: ' ' }, { date: 'invalid' },
    { error: undefined }, { error: '' }, { error: ' ' }, { response: undefined },
    { response: [] }, { response: null, error: 42 },
    { error: 'Ошибка одновременно с ответом' },
  ])('rejects malformed saved turns: %j', (changes) => {
    const conversations = emptyProfiles();
    const malformed = { ...turn(), ...changes };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...conversations, low: { ...conversations.low, direct: [malformed] },
    }));
    expect(loadConversations().warning).not.toBeNull();
  });

  it.each([
    { data: null }, { data: [] }, { data: [[], []] }, { data: {} }, { data: { low: {}, max: {} } },
  ])('rejects malformed profile containers: %j', ({ data }) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    expect(loadConversations().warning).not.toBeNull();
  });
});

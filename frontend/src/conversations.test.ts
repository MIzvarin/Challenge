import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHistory, emptyProfiles, LEGACY_STORAGE_KEY, PREVIOUS_STORAGE_KEY, loadConversations, saveConversations, STORAGE_KEY } from './conversations';
import type { Answer } from './api';
import type { Turn } from './conversations';
import { emptyConversations, makeAnswer, makeTemperatureAnswer } from './test-fixtures';

function turn(response: Answer = makeAnswer()): Turn {
  return { id: 'turn-1', question: response.question, date: response.date, response, error: null };
}

describe('conversations', () => {
  beforeEach(() => localStorage.clear());

  it('migrates v2 stages and failures without changing generation or importing v1', () => {
    const previous = { low: emptyConversations(), max: emptyConversations() };
    previous.low.prompt.push(turn(makeAnswer('Промпт', 'prompt')));
    previous.max.roles.push({ ...turn(), response: null, error: 'Сбой' });
    const generation = crypto.randomUUID();
    localStorage.setItem('challenge.conversations.generation', generation);
    localStorage.setItem(PREVIOUS_STORAGE_KEY, JSON.stringify(previous));
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(emptyConversations()));
    const { conversations, warning } = loadConversations();
    expect(warning).toBeNull();
    expect(conversations['reasoning:low:prompt']).toEqual(previous.low.prompt);
    expect(conversations['reasoning:max:roles']).toEqual(previous.max.roles);
    expect(conversations['temperature:0:direct']).toEqual([]);
    expect(localStorage.getItem(PREVIOUS_STORAGE_KEY)).not.toBeNull();
    expect(saveConversations(conversations)).toBeNull();
    expect(localStorage.getItem(PREVIOUS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('challenge.conversations.generation')).toBe(generation);
    expect(loadConversations().conversations).toEqual(conversations);
  });

  it.each([STORAGE_KEY, PREVIOUS_STORAGE_KEY])('does not fall back from corrupt %s or overwrite it on read', (key) => {
    localStorage.setItem(key, 'broken');
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(emptyConversations()));
    expect(loadConversations().warning).not.toBeNull();
    expect(localStorage.getItem(key)).toBe('broken');
  });

  it('prefers v3 to an older remaining copy', () => {
    const conversations = emptyProfiles();
    conversations['temperature:0:direct'].push(turn(makeTemperatureAnswer('Новый', 0)));
    saveConversations(conversations);
    localStorage.setItem(PREVIOUS_STORAGE_KEY, 'broken');
    expect(loadConversations()).toEqual({ conversations, warning: null });
    expect(buildHistory('direct', conversations['temperature:0:direct']).direct![0].content).toBe('Новый');
    expect(buildHistory('direct', conversations['temperature:0.7:direct'])).toEqual({ direct: [] });
  });

  it('preserves v2 if migration cannot be saved', () => {
    const raw = JSON.stringify({ low: emptyConversations(), max: emptyConversations() });
    localStorage.setItem(PREVIOUS_STORAGE_KEY, raw);
    const conversations = loadConversations().conversations;
    conversations['temperature:0:direct'].push(turn(makeTemperatureAnswer('Новый', 0)));
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota'); });
    try {
      expect(saveConversations(conversations)).not.toBeNull();
      expect(localStorage.getItem(PREVIOUS_STORAGE_KEY)).toBe(raw);
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    makeTemperatureAnswer('Вопрос', 1.2), makeAnswer('Вопрос'),
    { ...makeTemperatureAnswer('Вопрос', 0), temperature: undefined },
  ])('rejects temperature data from another scope: %j', (response) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...emptyProfiles(), 'temperature:0:direct': [turn(response as Answer)],
    }));
    expect(loadConversations().warning).not.toBeNull();
  });

  it('round-trips all conversations', () => {
    const conversations = emptyProfiles();
    conversations['reasoning:low:direct'].push(turn());
    conversations['reasoning:max:roles'].push(turn(makeAnswer('Задача', 'roles', 'max')));
    for (const temperature of [0, 0.7, 1.2] as const) conversations[`temperature:${temperature}:direct`].push(turn(makeTemperatureAnswer('Вопрос', temperature)));
    expect(saveConversations(conversations)).toBeNull();
    expect(loadConversations()).toEqual({ conversations, warning: null });
  });

  it('restores interrupted requests as errors, not permanent loading states', () => {
    const conversations = emptyProfiles();
    conversations['reasoning:low:direct'].push({ ...turn(), response: null });
    saveConversations(conversations);
    expect(loadConversations().conversations['reasoning:low:direct'][0].error).toContain('Запрос прерван');
  });

  it('does not interrupt a pending turn while another browser tab owns its request', () => {
    const conversations = emptyProfiles();
    conversations['reasoning:low:direct'].push({ ...turn(), response: null });
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
    conversations['reasoning:low:direct'].push(turn());
    const data = JSON.parse(JSON.stringify(conversations));
    data['reasoning:low:direct'][0].response.tokens = -1;
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
    expect(restored.conversations['reasoning:low:direct']).toEqual(conversations.direct);
    expect(restored.conversations['reasoning:max:direct']).toEqual([]);
    expect(restored.conversations['reasoning:low:direct'][0].response!.effort).toBeUndefined();
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
    saveConversations(restored.conversations);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(loadConversations().conversations).toEqual(restored.conversations);
  });

  it('rejects saved responses mixed between effort profiles', () => {
    const conversations = emptyProfiles();
    conversations['reasoning:max:direct'].push(turn(makeAnswer()));
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
    conversations['reasoning:low:direct'].push({ ...turn(), response: null, error: 'Ошибка запроса' });
    saveConversations(conversations);
    const restored = loadConversations().conversations;
    expect(restored).toEqual(conversations);
    expect(buildHistory('direct', restored['reasoning:low:direct'])).toEqual({ direct: [] });
  });

  it('rejects duplicate turn IDs within one conversation', () => {
    const conversations = emptyProfiles();
    conversations['reasoning:low:direct'].push(turn(), turn());
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
      ...conversations, 'reasoning:low:direct': [malformed],
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

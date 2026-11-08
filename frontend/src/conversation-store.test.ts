import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConversationStore, GENERATION_KEY, HISTORY_REVISION, REVISION_KEY } from './conversation-store';
import { buildHistory, emptyProfiles, HISTORY_STORAGE_KEYS, isPendingTurn, loadConversations, saveConversations, STORAGE_KEY } from './conversations';
import type { Profiles, Turn } from './conversations';
import type { Effort, Mode } from './modes';
import { makeAnswer, makeModelAnswer, makeTemperatureAnswer, withCosts } from './test-fixtures';
import { conversationKey } from './conversation-scope';

function turn(question: string, mode: Mode = 'direct', effort: Effort = 'low'): Turn {
  const response = makeAnswer(question, mode, effort);
  return { id: crypto.randomUUID(), question, date: response.date, response, error: null };
}

function append(profiles: Profiles, item: Turn, mode: Mode = 'direct', effort: Effort = 'low'): Profiles {
  const key = conversationKey({ workspace: 'reasoning', effort, mode });
  return { ...profiles, [key]: [...profiles[key], item] };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('conversation store', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(REVISION_KEY, HISTORY_REVISION);
  });

  it('clears every version and rejects old temperature replies without erasing a new conversation', async () => {
    const first = createConversationStore();
    const second = createConversationStore();
    const response = withCosts(makeTemperatureAnswer('Удалить', 0));
    const item: Turn = { id: crypto.randomUUID(), question: response.question, date: response.date, response, error: null };
    await first.update(({ conversations }) => ({ ...conversations, 'temperature:0:direct': [item] }));
    const oldGeneration = first.getSnapshot().generation!;
    for (const key of HISTORY_STORAGE_KEYS.slice(1)) localStorage.setItem(key, 'old text');
    await second.clear();
    for (const key of HISTORY_STORAGE_KEYS) expect(localStorage.getItem(key)).toBeNull();
    expect(second.getSnapshot().generation).not.toBe(oldGeneration);
    expect(second.getSnapshot().conversations).toEqual(emptyProfiles());
    await second.update(({ conversations }) => append(conversations, turn('Новый')));
    const stale = await first.update(({ conversations }) => ({ ...conversations, 'temperature:0:direct': [item] }), oldGeneration);
    expect(stale.applied).toBe(false);
    expect(first.getSnapshot().conversations['temperature:0:direct']).toEqual([]);
    expect(first.getSnapshot().conversations['reasoning:low:direct'][0].question).toBe('Новый');
  });

  it('merges concurrent temperature and reasoning changes under the same lock', async () => {
    const first = createConversationStore();
    const second = createConversationStore();
    const response = makeTemperatureAnswer('Температура', 0);
    const item: Turn = { id: crypto.randomUUID(), question: response.question, date: response.date, response, error: null };
    await Promise.all([
      first.update(({ conversations }) => ({ ...conversations, 'temperature:0:direct': [item] })),
      second.update(({ conversations }) => append(conversations, turn('Рассуждения'))),
    ]);
    await first.refresh();
    expect(first.getSnapshot().conversations['temperature:0:direct']).toEqual([item]);
    expect(first.getSnapshot().conversations['reasoning:low:direct']).toHaveLength(1);
  });

  it('merges priced model and original groups and never sends prices as context', async () => {
    const first = createConversationStore();
    const second = createConversationStore();
    const original = turn('Роли', 'roles');
    original.response = withCosts(original.response!);
    const response = withCosts(makeModelAnswer('Модель'));
    const model: Turn = { id: crypto.randomUUID(), question: response.question, date: response.date, response, error: null };
    await Promise.all([
      first.update(({ conversations }) => ({ ...conversations, 'reasoning:low:roles': [original] })),
      second.update(({ conversations }) => ({ ...conversations, 'models:kimi-k2.7-code:direct': [model] })),
    ]);
    await first.refresh();
    const restored = first.getSnapshot().conversations;
    expect(restored['reasoning:low:roles']).toEqual([original]);
    expect(restored['models:kimi-k2.7-code:direct']).toEqual([model]);
    const context = JSON.stringify(buildHistory('roles', restored['reasoning:low:roles']));
    expect(context).toContain('Разбор задачи');
    for (const value of ['pricing_version', 'amount', 'opencode.ai', '0.001']) expect(context).not.toContain(value);
    const generation = first.getSnapshot().generation!;
    await second.clear();
    expect((await first.update(() => restored, generation)).applied).toBe(false);
    expect(first.getSnapshot().conversations).toEqual(emptyProfiles());
  });

  it('keeps live temperature turns pending and refuses a duplicate while allowing other scopes', async () => {
    const first = createConversationStore();
    const second = createConversationStore();
    const item: Turn = { ...turn('Ожидание'), response: null };
    const started = deferred();
    const finish = deferred();
    const request = first.trackRequest(item.id, async () => {
      await first.update(({ conversations }) => ({ ...conversations, 'temperature:0.7:direct': [item] }));
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    try {
      await second.refresh();
      expect(second.getSnapshot().conversations['temperature:0.7:direct'][0].error).toBeNull();
      expect((await second.update(({ conversations }) => (
        conversations['temperature:0.7:direct'].some(isPendingTurn) ? null : conversations
      ))).applied).toBe(false);
      expect((await second.update(({ conversations }) => append(conversations, turn('Другой раздел')))).applied).toBe(true);
    } finally {
      finish.resolve();
      await request;
    }
    await second.refresh();
    expect(second.getSnapshot().conversations['temperature:0.7:direct'][0].error).toContain('Запрос прерван');
  });

  it.each(HISTORY_STORAGE_KEYS)('refreshes on history version event %s', async (key) => {
    const store = createConversationStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await store.refresh();
    listener.mockClear();
    window.dispatchEvent(new StorageEvent('storage', { key }));
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    unsubscribe();
  });

  it('serializes concurrent writes using current storage instead of either tab’s snapshot', async () => {
    const first = createConversationStore();
    const second = createConversationStore();
    const direct = turn('Первый');
    const roles = turn('Второй', 'roles', 'max');
    await Promise.all([
      first.update(({ conversations }) => append(conversations, direct)),
      second.update(({ conversations }) => append(conversations, roles, 'roles', 'max')),
    ]);
    await first.refresh();
    expect(first.getSnapshot().conversations['reasoning:low:direct']).toEqual([direct]);
    expect(first.getSnapshot().conversations['reasoning:max:roles']).toEqual([roles]);
    expect(loadConversations().conversations).toEqual(first.getSnapshot().conversations);
    expect(first.getSnapshot().generation).toBe(second.getSnapshot().generation);
  });

  it('refreshes subscribers on storage events and focus, and unsubscribes cleanly', async () => {
    const first = createConversationStore();
    const second = createConversationStore();
    const listener = vi.fn();
    const unsubscribe = second.subscribe(listener);
    await second.refresh();
    const item = turn('Из другой вкладки');
    await first.update(({ conversations }) => append(conversations, item));
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    await vi.waitFor(() => expect(second.getSnapshot().conversations['reasoning:low:direct']).toEqual([item]));
    await first.clear();
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(second.getSnapshot().conversations).toEqual(emptyProfiles()));
    unsubscribe();
    listener.mockClear();
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    window.dispatchEvent(new Event('focus'));
    await first.refresh();
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects a late reply after another tab clears, even before its storage event arrives', async () => {
    const first = createConversationStore();
    const second = createConversationStore();
    await first.update(({ conversations }) => append(conversations, turn('Удалённый вопрос')));
    const oldGeneration = first.getSnapshot().generation!;
    const reset = vi.fn();
    first.onReset(reset);
    await second.clear();
    const change = vi.fn(({ conversations }) => append(conversations, turn('Поздний ответ')));
    expect((await first.update(change, oldGeneration)).applied).toBe(false);
    expect(change).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(first.getSnapshot().generation).toBe(second.getSnapshot().generation);
    expect(first.getSnapshot().conversations).toEqual(emptyProfiles());
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('reads fresh empty history for the next question after a remote clear', async () => {
    const first = createConversationStore();
    const second = createConversationStore();
    await first.update(({ conversations }) => append(conversations, turn('Удалено')));
    await second.clear();
    const item = turn('Новая задача');
    await first.update(({ conversations }) => {
      expect(conversations).toEqual(emptyProfiles());
      return append(conversations, item);
    });
    expect(loadConversations().conversations['reasoning:low:direct']).toEqual([item]);
  });

  it('preserves a request owned by another tab and blocks a second request in that conversation', async () => {
    const first = createConversationStore();
    const second = createConversationStore();
    const item = turn('Долгий вопрос');
    const started = deferred();
    const finish = deferred();
    const request = first.trackRequest(item.id, async () => {
      const { snapshot } = await first.update(({ conversations }) => append(conversations, { ...item, response: null }));
      started.resolve();
      await finish.promise;
      await first.update(({ conversations }) => ({
        ...conversations, 'reasoning:low:direct': [item],
      }), snapshot.generation!);
    });
    await started.promise;
    try {
      await second.refresh();
      expect(second.getSnapshot().conversations['reasoning:low:direct'][0]).toMatchObject({ response: null, error: null });
      const result = await second.update(({ conversations }) => (
        conversations['reasoning:low:direct'].some(isPendingTurn) ? null : append(conversations, turn('Дубликат'))
      ));
      expect(result.applied).toBe(false);
      await second.update(({ conversations }) => append(conversations, turn('Другая задача', 'steps'), 'steps'));
    } finally {
      finish.resolve();
      await request;
    }
    await second.refresh();
    expect(second.getSnapshot().conversations['reasoning:low:direct']).toEqual([item]);
    expect(second.getSnapshot().conversations['reasoning:low:steps'][0].question).toBe('Другая задача');
  });

  it('recovers pending turns only after their request lock has been released', async () => {
    const first = createConversationStore();
    const item = turn('Прерванный вопрос');
    await first.trackRequest(item.id, () => first.update(({ conversations }) => append(conversations, { ...item, response: null })));
    const reloaded = createConversationStore();
    await reloaded.refresh();
    expect(reloaded.getSnapshot().conversations['reasoning:low:direct'][0].error).toContain('Запрос прерван');
  });

  it('keeps the generation across reloads and rotates it only when history is cleared', async () => {
    const first = createConversationStore();
    await first.refresh();
    const generation = first.getSnapshot().generation;
    await first.update(({ conversations }) => append(conversations, turn('Первый')));
    const reloaded = createConversationStore();
    await reloaded.refresh();
    expect(reloaded.getSnapshot().generation).toBe(generation);
    await reloaded.clear();
    expect(reloaded.getSnapshot().generation).not.toBe(generation);
    expect(localStorage.getItem(GENERATION_KEY)).toBe(reloaded.getSnapshot().generation);
  });

  it('invalidates old requests when browser storage is cleared externally', async () => {
    const store = createConversationStore();
    await store.refresh();
    const generation = store.getSnapshot().generation!;
    localStorage.clear();
    const result = await store.update(() => emptyProfiles(), generation);
    expect(result.applied).toBe(false);
    expect(result.snapshot.generation).not.toBe(generation);
  });

  it.each([null, '', 'broken-id'])('repairs invalid generation %j without dropping saved history', async (generation) => {
    const profiles = append(emptyProfiles(), turn('Сохранённая задача'));
    saveConversations(profiles);
    if (generation !== null) localStorage.setItem(GENERATION_KEY, generation);
    const store = createConversationStore();
    await store.refresh();
    expect(store.getSnapshot().generation).toMatch(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
    expect(store.getSnapshot().conversations).toEqual(profiles);
  });

  it('keeps page-memory updates after a failed save, but still honors a remote clear', async () => {
    const store = createConversationStore();
    await store.refresh();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota'); });
    try {
      await store.update(({ conversations }) => append(conversations, turn('Первый')));
      await store.update(({ conversations }) => append(conversations, turn('Второй')));
      await store.refresh();
      expect(store.getSnapshot().conversations['reasoning:low:direct']).toHaveLength(2);
      expect(store.getSnapshot().warning).toContain('Не удалось сохранить историю');
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    } finally {
      spy.mockRestore();
    }
    await createConversationStore().clear();
    await store.refresh();
    expect(store.getSnapshot().conversations).toEqual(emptyProfiles());
  });

  it('does not write shared history without Web Locks', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const store = createConversationStore();
    const item = turn('Только эта страница');
    await store.update(({ conversations }) => append(conversations, item));
    await store.refresh();
    expect(store.getSnapshot().conversations['reasoning:low:direct']).toEqual([item]);
    expect(store.getSnapshot().warning).toContain('не поддерживает синхронизацию');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    await store.clear();
    expect(store.getSnapshot().conversations).toEqual(emptyProfiles());
  });
});

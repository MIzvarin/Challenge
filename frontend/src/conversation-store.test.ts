import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConversationStore, GENERATION_KEY } from './conversation-store';
import { emptyProfiles, isPendingTurn, loadConversations, saveConversations, STORAGE_KEY } from './conversations';
import type { Profiles, Turn } from './conversations';
import type { Effort, Mode } from './modes';
import { makeAnswer } from './test-fixtures';

function turn(question: string, mode: Mode = 'direct', effort: Effort = 'low'): Turn {
  const response = makeAnswer(question, mode, effort);
  return { id: crypto.randomUUID(), question, date: response.date, response, error: null };
}

function append(profiles: Profiles, item: Turn, mode: Mode = 'direct', effort: Effort = 'low'): Profiles {
  return { ...profiles, [effort]: { ...profiles[effort], [mode]: [...profiles[effort][mode], item] } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('conversation store', () => {
  beforeEach(() => localStorage.clear());

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
    expect(first.getSnapshot().conversations.low.direct).toEqual([direct]);
    expect(first.getSnapshot().conversations.max.roles).toEqual([roles]);
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
    await vi.waitFor(() => expect(second.getSnapshot().conversations.low.direct).toEqual([item]));
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
    expect(loadConversations().conversations.low.direct).toEqual([item]);
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
        ...conversations, low: { ...conversations.low, direct: [item] },
      }), snapshot.generation!);
    });
    await started.promise;
    try {
      await second.refresh();
      expect(second.getSnapshot().conversations.low.direct[0]).toMatchObject({ response: null, error: null });
      const result = await second.update(({ conversations }) => (
        conversations.low.direct.some(isPendingTurn) ? null : append(conversations, turn('Дубликат'))
      ));
      expect(result.applied).toBe(false);
      await second.update(({ conversations }) => append(conversations, turn('Другая задача', 'steps'), 'steps'));
    } finally {
      finish.resolve();
      await request;
    }
    await second.refresh();
    expect(second.getSnapshot().conversations.low.direct).toEqual([item]);
    expect(second.getSnapshot().conversations.low.steps[0].question).toBe('Другая задача');
  });

  it('recovers pending turns only after their request lock has been released', async () => {
    const first = createConversationStore();
    const item = turn('Прерванный вопрос');
    await first.trackRequest(item.id, () => first.update(({ conversations }) => append(conversations, { ...item, response: null })));
    const reloaded = createConversationStore();
    await reloaded.refresh();
    expect(reloaded.getSnapshot().conversations.low.direct[0].error).toContain('Запрос прерван');
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
      expect(store.getSnapshot().conversations.low.direct).toHaveLength(2);
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
    expect(store.getSnapshot().conversations.low.direct).toEqual([item]);
    expect(store.getSnapshot().warning).toContain('не поддерживает синхронизацию');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    await store.clear();
    expect(store.getSnapshot().conversations).toEqual(emptyProfiles());
  });
});

import { beforeEach, expect, it, vi } from 'vitest';
import { createConversationStore, GENERATION_KEY, HISTORY_REVISION, REVISION_KEY } from './conversation-store';
import { emptyProfiles, HISTORY_STORAGE_KEYS, saveConversations } from './conversations';
import { makeAnswer, makeScopedAnswer } from './test-fixtures';
import { CONVERSATION_SCOPES, conversationKey } from './conversation-scope';

beforeEach(() => localStorage.clear());

function seedOldHistory(): string {
  const generation = crypto.randomUUID();
  localStorage.setItem(GENERATION_KEY, generation);
  for (const key of HISTORY_STORAGE_KEYS) localStorage.setItem(key, 'old text');
  return generation;
}

it('starts empty and uninitialized, removes all copies and commits revision last', async () => {
  const generation = seedOldHistory();
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  const store = createConversationStore();
  expect(store.getSnapshot()).toMatchObject({ conversations: emptyProfiles(), initialized: false, generation: null });
  await store.refresh();
  expect(store.getSnapshot()).toMatchObject({ conversations: emptyProfiles(), initialized: true, warning: null });
  expect(store.getSnapshot().generation).not.toBe(generation);
  for (const key of HISTORY_STORAGE_KEYS) expect(localStorage.getItem(key)).toBeNull();
  expect(writes.mock.calls.map(([key]) => key)).toEqual([GENERATION_KEY, REVISION_KEY]);
  writes.mockRestore();
});

it('resets only once across concurrent starts, preserves new history and revision on ordinary clear', async () => {
  seedOldHistory();
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  const first = createConversationStore();
  const second = createConversationStore();
  await Promise.all([first.refresh(), second.refresh()]);
  expect(writes.mock.calls.filter(([key]) => key === REVISION_KEY)).toHaveLength(1);
  writes.mockRestore();
  const profiles = emptyProfiles();
  for (const scope of CONVERSATION_SCOPES) {
    const key = conversationKey(scope);
    const response = makeScopedAnswer(`Новая история ${key}`, scope);
    profiles[key] = [{ id: key, question: response.question, date: response.date, response, error: null }];
  }
  saveConversations(profiles);
  const reloaded = createConversationStore();
  await reloaded.refresh();
  expect(reloaded.getSnapshot().conversations).toEqual(profiles);
  const generation = reloaded.getSnapshot().generation;
  await reloaded.clear();
  expect(localStorage.getItem(REVISION_KEY)).toBe(HISTORY_REVISION);
  const clearedGeneration = reloaded.getSnapshot().generation;
  expect(clearedGeneration).not.toBe(generation);
  await createConversationStore().refresh();
  expect(localStorage.getItem(GENERATION_KEY)).toBe(clearedGeneration);
});

it('rejects old-generation results and notifies reset listeners before the storage event', async () => {
  const first = createConversationStore();
  await first.refresh();
  const generation = first.getSnapshot().generation!;
  const onReset = vi.fn();
  first.onReset(onReset);
  localStorage.removeItem(REVISION_KEY);
  await createConversationStore().refresh();
  const change = vi.fn(() => emptyProfiles());
  expect((await first.update(change, generation)).applied).toBe(false);
  expect(change).not.toHaveBeenCalled();
  expect(onReset).toHaveBeenCalledOnce();
});

it.each(['no-locks', 'read', 'remove', 'generation', 'revision'])('uses empty page memory on %s and retries on next start', async (failure) => {
  seedOldHistory();
  const locks = navigator.locks;
  if (failure === 'no-locks') Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  const get = Storage.prototype.getItem;
  const set = Storage.prototype.setItem;
  const remove = Storage.prototype.removeItem;
  const spies = [
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (failure === 'read') throw new Error('storage');
      return get.call(this, key);
    }),
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if ((failure === 'generation' && key === GENERATION_KEY) || (failure === 'revision' && key === REVISION_KEY)) throw new Error('storage');
      return set.call(this, key, value);
    }),
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
      if (failure === 'remove') throw new Error('storage');
      return remove.call(this, key);
    }),
  ];
  try {
    const store = createConversationStore();
    await store.refresh();
    expect(store.getSnapshot().conversations).toEqual(emptyProfiles());
    expect(store.getSnapshot().warning).not.toBeNull();
    expect(store.getSnapshot().initialized).toBe(true);
    expect(get.call(localStorage, REVISION_KEY)).toBeNull();
    const response = makeAnswer('В памяти');
    await store.update(({ conversations }) => ({ ...conversations, 'reasoning:low:direct': [
      { id: 'memory', question: response.question, date: response.date, response, error: null },
    ] }));
    expect(store.getSnapshot().conversations['reasoning:low:direct']).toHaveLength(1);
    expect(get.call(localStorage, REVISION_KEY)).toBeNull();
  } finally {
    spies.forEach((spy) => spy.mockRestore());
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
  }
  await createConversationStore().refresh();
  expect(localStorage.getItem(REVISION_KEY)).toBe(HISTORY_REVISION);
});

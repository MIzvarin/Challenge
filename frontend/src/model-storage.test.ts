import { beforeEach, expect, it, vi } from 'vitest';
import { createConversationStore, GENERATION_KEY, HISTORY_REVISION, REVISION_KEY } from './conversation-store';
import { emptyProfiles, HISTORY_STORAGE_KEYS, isPendingTurn, loadConversations, MODEL_STORAGE_KEY, saveConversations, STORAGE_KEY } from './conversations';
import type { Turn } from './conversations';
import { CHAT_MODELS } from './modes';
import type { ChatModel } from './modes';
import { conversationKey } from './conversation-scope';
import { makeAnswer, makeModelAnswer } from './test-fixtures';

function turn(model: ChatModel): Turn {
  const response = makeModelAnswer(model, model);
  return { id: crypto.randomUUID(), question: model, date: response.date, response, error: null };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(REVISION_KEY, HISTORY_REVISION);
});

it('stores 13 original scopes and three model histories separately and restores all sixteen', () => {
  const profiles = emptyProfiles();
  const response = makeAnswer();
  profiles['reasoning:low:direct'] = [{ id: 'old', question: response.question, date: response.date, response, error: null }];
  for (const model of CHAT_MODELS) profiles[conversationKey({ workspace: 'models', model, mode: 'direct' })] = [turn(model)];
  expect(saveConversations(profiles)).toBeNull();
  expect(Object.keys(JSON.parse(localStorage.getItem(STORAGE_KEY)!))).toHaveLength(13);
  expect(Object.keys(JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY)!))).toEqual(CHAT_MODELS);
  expect(loadConversations()).toEqual({ conversations: profiles, warning: null });
  localStorage.removeItem(MODEL_STORAGE_KEY);
  const loaded = loadConversations();
  expect(loaded.conversations['reasoning:low:direct']).toEqual(profiles['reasoning:low:direct']);
  for (const model of CHAT_MODELS) expect(loaded.conversations[conversationKey({ workspace: 'models', model, mode: 'direct' })]).toEqual([]);
});

it('keeps original history visible when model history is damaged and does not overwrite it on read', () => {
  const profiles = emptyProfiles();
  const response = makeAnswer();
  profiles['reasoning:low:direct'] = [{ id: 'old', question: response.question, date: response.date, response, error: null }];
  saveConversations(profiles);
  localStorage.setItem(MODEL_STORAGE_KEY, 'broken');
  expect(loadConversations().warning).toContain('моделей');
  expect(loadConversations().conversations['reasoning:low:direct']).toHaveLength(1);
  expect(localStorage.getItem(MODEL_STORAGE_KEY)).toBe('broken');
});

it('rejects a saved response from another model', () => {
  localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({
    'kimi-k2.7-code': [turn('grok-4.7')], 'grok-4.7': [], 'gpt-6-luna': [],
  }));
  expect(loadConversations().warning).not.toBeNull();
});

it('writes only changed groups, preserves generation and merges model changes under the shared lock', async () => {
  const first = createConversationStore();
  const second = createConversationStore();
  await first.refresh();
  const generation = first.getSnapshot().generation;
  const spy = vi.spyOn(Storage.prototype, 'setItem');
  try {
    await Promise.all([
      first.update(({ conversations }) => ({ ...conversations, 'models:kimi-k2.7-code:direct': [turn('kimi-k2.7-code')] })),
      second.update(({ conversations }) => ({ ...conversations, 'models:grok-4.7:direct': [turn('grok-4.7')] })),
    ]);
    expect(spy.mock.calls.some(([key]) => key === STORAGE_KEY)).toBe(false);
    await first.refresh();
    expect(first.getSnapshot().conversations['models:kimi-k2.7-code:direct']).toHaveLength(1);
    expect(first.getSnapshot().conversations['models:grok-4.7:direct']).toHaveLength(1);
    expect(localStorage.getItem(GENERATION_KEY)).toBe(generation);
  } finally { spy.mockRestore(); }
});

it('reserves a pending model across stores, allows another model and rejects late replies after clear', async () => {
  const first = createConversationStore();
  const second = createConversationStore();
  const pending = { ...turn('kimi-k2.7-code'), response: null };
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const finish = new Promise<void>((resolve) => { release = resolve; });
  const active = first.trackRequest(pending.id, async () => {
    await first.update(({ conversations }) => ({ ...conversations, 'models:kimi-k2.7-code:direct': [pending] }));
    started();
    await finish;
  });
  await ready;
  const generation = first.getSnapshot().generation!;
  try {
    await second.refresh();
    expect(second.getSnapshot().conversations['models:kimi-k2.7-code:direct'][0].error).toBeNull();
    expect((await second.update(({ conversations }) => conversations['models:kimi-k2.7-code:direct'].some(isPendingTurn) ? null : conversations)).applied).toBe(false);
    expect((await second.update(({ conversations }) => ({ ...conversations, 'models:grok-4.7:direct': [turn('grok-4.7')] }))).applied).toBe(true);
    await second.clear();
    for (const key of HISTORY_STORAGE_KEYS) expect(localStorage.getItem(key)).toBeNull();
    const late = await first.update(({ conversations }) => ({ ...conversations, 'models:kimi-k2.7-code:direct': [turn('kimi-k2.7-code')] }), generation);
    expect(late.applied).toBe(false);
    expect(first.getSnapshot().conversations).toEqual(emptyProfiles());
  } finally { release(); await active; }
});

it('restores abandoned model requests as interrupted and synchronizes model storage/focus events', async () => {
  const profiles = emptyProfiles();
  profiles['models:kimi-k2.7-code:direct'] = [{ ...turn('kimi-k2.7-code'), response: null }];
  saveConversations(profiles);
  expect(loadConversations().conversations['models:kimi-k2.7-code:direct'][0].error).toContain('Запрос прерван');
  const store = createConversationStore();
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);
  try {
    await store.refresh();
    for (const event of [new StorageEvent('storage', { key: MODEL_STORAGE_KEY }), new Event('focus')]) {
      listener.mockClear();
      window.dispatchEvent(event);
      await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    }
  } finally { unsubscribe(); }
});

it.each(['quota', 'no-locks'])('keeps model history in memory on %s', async (failure) => {
  if (failure === 'no-locks') Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  const store = createConversationStore();
  await store.refresh();
  const original = Storage.prototype.setItem;
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === MODEL_STORAGE_KEY) throw new Error('quota');
    original.call(this, key, value);
  });
  try {
    await store.update(({ conversations }) => ({ ...conversations, 'models:kimi-k2.7-code:direct': [turn('kimi-k2.7-code')] }));
    expect(store.getSnapshot().conversations['models:kimi-k2.7-code:direct']).toHaveLength(1);
    expect(store.getSnapshot().warning).not.toBeNull();
    expect(localStorage.getItem(MODEL_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  } finally { spy.mockRestore(); }
});

it('does not overwrite broken model data when an unrelated dialog changes', async () => {
  localStorage.setItem(MODEL_STORAGE_KEY, 'broken');
  const store = createConversationStore();
  await store.refresh();
  const warning = store.getSnapshot().warning;
  expect(warning).toContain('историю моделей');
  const response = makeAnswer();
  await store.update(({ conversations }) => ({ ...conversations, 'reasoning:low:direct': [
    { id: 'old', question: response.question, date: response.date, response, error: null },
  ] }));
  expect(localStorage.getItem(MODEL_STORAGE_KEY)).toBe('broken');
  expect(store.getSnapshot().warning).toBe(warning);
  await store.refresh();
  expect(store.getSnapshot().warning).toBe(warning);
  await store.clear();
  expect(store.getSnapshot().warning).toBeNull();
});

it('clears the model read warning after successfully replacing the damaged model history', async () => {
  localStorage.setItem(MODEL_STORAGE_KEY, 'broken');
  const store = createConversationStore();
  await store.refresh();
  expect(store.getSnapshot().warning).not.toBeNull();
  const item = turn('kimi-k2.7-code');
  await store.update(({ conversations }) => ({ ...conversations, 'models:kimi-k2.7-code:direct': [item] }));
  expect(store.getSnapshot().warning).toBeNull();
  expect(loadConversations().conversations['models:kimi-k2.7-code:direct']).toEqual([item]);
});

it('preserves the original-history warning when only model history is saved', async () => {
  localStorage.setItem(STORAGE_KEY, 'broken');
  const store = createConversationStore();
  await store.refresh();
  const warning = store.getSnapshot().warning;
  expect(warning).not.toBeNull();
  const item = turn('kimi-k2.7-code');
  await store.update(({ conversations }) => ({ ...conversations, 'models:kimi-k2.7-code:direct': [item] }));
  expect(store.getSnapshot().warning).toBe(warning);
  expect(localStorage.getItem(STORAGE_KEY)).toBe('broken');
  expect(loadConversations().conversations['models:kimi-k2.7-code:direct']).toEqual([item]);
});

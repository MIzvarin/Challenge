import { emptyProfiles, LEGACY_STORAGE_KEY, loadConversations, saveConversations, STORAGE_KEY } from './conversations';
import type { Profiles } from './conversations';

export const GENERATION_KEY = 'challenge.conversations.generation';
const HISTORY_LOCK = 'challenge.conversations';
const REQUEST_LOCK_PREFIX = 'challenge.request.';
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const STORAGE_WARNING = 'Не удалось сохранить историю в браузере. Она доступна только до закрытия или обновления страницы.';
const LOCKS_WARNING = 'Браузер не поддерживает синхронизацию истории. Переписка доступна только на этой странице и не сохраняется.';

function validGeneration(value: string | null): string {
  return value !== null && UUID_PATTERN.test(value) ? value : crypto.randomUUID();
}

export interface ConversationSnapshot {
  conversations: Profiles;
  generation: string | null;
  warning: string | null;
}

interface UpdateResult {
  snapshot: ConversationSnapshot;
  applied: boolean;
}

export interface ConversationStore {
  getSnapshot: () => ConversationSnapshot;
  subscribe: (listener: () => void) => () => void;
  onReset: (listener: () => void) => () => void;
  update: (change: (current: ConversationSnapshot) => Profiles | null, expectedGeneration?: string) => Promise<UpdateResult>;
  clear: () => Promise<void>;
  refresh: () => Promise<void>;
  trackRequest: <T>(id: string, task: () => Promise<T>) => Promise<T>;
}

export function createConversationStore(): ConversationStore {
  const locks = navigator.locks;
  let persistent = Boolean(locks);
  let snapshot: ConversationSnapshot = { ...loadConversations(), generation: null };
  let lastStoredGeneration: string | null | undefined;
  const listeners = new Set<() => void>();
  const resetListeners = new Set<() => void>();

  function getSnapshot(): ConversationSnapshot {
    return snapshot;
  }

  function publish(next: ConversationSnapshot): void {
    const reset = snapshot.generation !== null && snapshot.generation !== next.generation;
    snapshot = next;
    if (reset) resetListeners.forEach((listener) => listener());
    listeners.forEach((listener) => listener());
  }

  async function locked<T>(name: string, task: () => Promise<T>): Promise<T> {
    if (locks) return await locks.request(name, task);
    return task();
  }

  async function read(): Promise<ConversationSnapshot> {
    try {
      let generation = localStorage.getItem(GENERATION_KEY);
      if (!persistent) {
        if (lastStoredGeneration !== undefined && generation !== lastStoredGeneration) {
          lastStoredGeneration = generation;
          return { conversations: emptyProfiles(), generation: validGeneration(generation), warning: snapshot.warning };
        }
        lastStoredGeneration = generation;
        return { ...snapshot, generation: snapshot.generation ?? validGeneration(generation), warning: locks ? STORAGE_WARNING : LOCKS_WARNING };
      }
      if (generation === null || !UUID_PATTERN.test(generation)) {
        generation = validGeneration(generation);
        localStorage.setItem(GENERATION_KEY, generation);
      }
      lastStoredGeneration = generation;
      const { held = [] } = await locks.query();
      const activeRequests = new Set(held.flatMap((lock) => (
        lock.name?.startsWith(REQUEST_LOCK_PREFIX) ? [lock.name.slice(REQUEST_LOCK_PREFIX.length)] : []
      )));
      return { ...loadConversations(activeRequests), generation };
    } catch {
      persistent = false;
      return { ...snapshot, generation: snapshot.generation ?? crypto.randomUUID(), warning: STORAGE_WARNING };
    }
  }

  async function refresh(): Promise<void> {
    await locked(HISTORY_LOCK, async () => publish(await read()));
  }

  function handleStorage(event: StorageEvent): void {
    if (event.key === null || [STORAGE_KEY, LEGACY_STORAGE_KEY, GENERATION_KEY].includes(event.key)) {
      void refresh();
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (listeners.size === 1) {
      window.addEventListener('storage', handleStorage);
      window.addEventListener('focus', refresh);
      void refresh();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        window.removeEventListener('storage', handleStorage);
        window.removeEventListener('focus', refresh);
      }
    };
  }

  function onReset(listener: () => void): () => void {
    resetListeners.add(listener);
    return () => { resetListeners.delete(listener); };
  }

  async function update(
    change: (current: ConversationSnapshot) => Profiles | null,
    expectedGeneration?: string,
  ): Promise<UpdateResult> {
    return locked(HISTORY_LOCK, async () => {
      publish(await read());
      if (expectedGeneration !== undefined && snapshot.generation !== expectedGeneration) {
        return { snapshot, applied: false };
      }
      const conversations = change(snapshot);
      if (conversations === null) return { snapshot, applied: false };
      let warning = snapshot.warning;
      if (persistent) {
        warning = saveConversations(conversations);
        if (warning) persistent = false;
      }
      publish({ ...snapshot, conversations, warning });
      return { snapshot, applied: true };
    });
  }

  async function clear(): Promise<void> {
    await locked(HISTORY_LOCK, async () => {
      const generation = crypto.randomUUID();
      let warning: string | null = null;
      try {
        // The lock makes removal and the new generation one atomic operation for other tabs.
        localStorage.removeItem(GENERATION_KEY);
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        localStorage.setItem(GENERATION_KEY, generation);
        lastStoredGeneration = generation;
        persistent = Boolean(locks);
        if (!locks) warning = LOCKS_WARNING;
      } catch {
        persistent = false;
        lastStoredGeneration = undefined;
        warning = STORAGE_WARNING;
      }
      publish({ conversations: emptyProfiles(), generation, warning });
    });
  }

  function trackRequest<T>(id: string, task: () => Promise<T>): Promise<T> {
    // A live request holds its lock until completion. Closed/reloaded tabs release it automatically.
    return locked(`${REQUEST_LOCK_PREFIX}${id}`, task);
  }

  return { getSnapshot, subscribe, onReset, update, clear, refresh, trackRequest };
}

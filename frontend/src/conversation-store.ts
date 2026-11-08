import { emptyProfiles, HISTORY_STORAGE_KEYS, loadConversations, saveConversations } from './conversations';
import type { Profiles } from './conversations';

export const GENERATION_KEY = 'challenge.conversations.generation';
export const REVISION_KEY = 'challenge.conversations.revision';
export const HISTORY_REVISION = 'kimi-grok-luna-v1';
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
  initialized: boolean;
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
  let snapshot: ConversationSnapshot = { conversations: emptyProfiles(), generation: null, warning: null, initialized: false };
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
    let resetting = false;
    try {
      if (persistent && localStorage.getItem(REVISION_KEY) !== HISTORY_REVISION) {
        resetting = true;
        resetStorage();
        // Commit the revision only after every removal and generation write succeeded.
        localStorage.setItem(REVISION_KEY, HISTORY_REVISION);
      }
      let generation = localStorage.getItem(GENERATION_KEY);
      if (!persistent) {
        if (lastStoredGeneration !== undefined && generation !== lastStoredGeneration) {
          lastStoredGeneration = generation;
          return { conversations: emptyProfiles(), generation: validGeneration(generation), warning: snapshot.warning, initialized: true };
        }
        lastStoredGeneration = generation;
        return { ...snapshot, generation: snapshot.generation ?? validGeneration(generation), warning: locks ? STORAGE_WARNING : LOCKS_WARNING, initialized: true };
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
      return { ...loadConversations(activeRequests), generation, initialized: true };
    } catch {
      persistent = false;
      return {
        ...snapshot,
        conversations: resetting ? emptyProfiles() : snapshot.conversations,
        generation: resetting ? crypto.randomUUID() : snapshot.generation ?? crypto.randomUUID(),
        warning: STORAGE_WARNING,
        initialized: true,
      };
    }
  }

  async function refresh(): Promise<void> {
    await locked(HISTORY_LOCK, async () => publish(await read()));
  }

  function handleStorage(event: StorageEvent): void {
    if (event.key === null || [...HISTORY_STORAGE_KEYS, GENERATION_KEY, REVISION_KEY].includes(event.key)) {
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
        const saveWarning = saveConversations(conversations, snapshot.conversations);
        if (saveWarning) {
          warning = saveWarning;
          persistent = false;
        } else if (warning !== null) {
          // Saving one group does not necessarily repair another group's read error.
          warning = loadConversations().warning;
        }
      }
      publish({ ...snapshot, conversations, warning });
      return { snapshot, applied: true };
    });
  }

  function resetStorage(): string {
    const generation = crypto.randomUUID();
    localStorage.removeItem(GENERATION_KEY);
    for (const key of HISTORY_STORAGE_KEYS) localStorage.removeItem(key);
    localStorage.setItem(GENERATION_KEY, generation);
    lastStoredGeneration = generation;
    return generation;
  }

  async function clear(): Promise<void> {
    await locked(HISTORY_LOCK, async () => {
      let generation: string = crypto.randomUUID();
      let warning: string | null = null;
      try {
        // The lock makes removal and the new generation one atomic operation for other tabs.
        if (locks) generation = resetStorage();
        persistent = Boolean(locks);
        if (!locks) warning = LOCKS_WARNING;
      } catch {
        persistent = false;
        lastStoredGeneration = undefined;
        warning = STORAGE_WARNING;
      }
      publish({ conversations: emptyProfiles(), generation, warning, initialized: true });
    });
  }

  function trackRequest<T>(id: string, task: () => Promise<T>): Promise<T> {
    // A live request holds its lock until completion. Closed/reloaded tabs release it automatically.
    return locked(`${REQUEST_LOCK_PREFIX}${id}`, task);
  }

  return { getSnapshot, subscribe, onReset, update, clear, refresh, trackRequest };
}

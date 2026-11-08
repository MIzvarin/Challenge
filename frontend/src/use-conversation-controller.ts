import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { askQuestion } from './api';
import type { History } from './api';
import { conversationKey, conversationRecord } from './conversation-scope';
import type { ConversationKey, ConversationScope } from './conversation-scope';
import { createConversationStore } from './conversation-store';
import { buildHistory, isPendingTurn } from './conversations';
import type { Turn } from './conversations';

interface ActiveRequest {
  controller: AbortController;
  timeout: number;
}

interface ConversationController {
  turns: Turn[];
  question: string;
  storageWarning: string | null;
  isClearing: boolean;
  isSubmitting: boolean;
  updateDraft: (question: string) => void;
  handleSubmit: () => Promise<void>;
  clearHistory: () => Promise<void>;
}

function abortRequests(requests: Map<ConversationKey, ActiveRequest>): void {
  for (const request of requests.values()) {
    window.clearTimeout(request.timeout);
    request.controller.abort();
  }
  requests.clear();
}

function emptyDrafts(): Record<ConversationKey, string> {
  return conversationRecord(() => '');
}

function requestError(cause: unknown, aborted: boolean): string {
  if (aborted) return 'Время ожидания истекло. Попробуйте ещё раз.';
  if (cause instanceof TypeError) return 'Нет связи с сервером. Проверьте подключение и запуск бэкенда.';
  return cause instanceof Error ? cause.message : 'Не удалось получить ответ. Попробуйте ещё раз.';
}

export function useConversationController(scope: ConversationScope): ConversationController {
  const [store] = useState(createConversationStore);
  const { conversations, warning: storageWarning, initialized } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [drafts, setDrafts] = useState(emptyDrafts);
  const [isClearing, setIsClearing] = useState(false);
  const activeRequests = useRef(new Map<ConversationKey, ActiveRequest>());
  const key = conversationKey(scope);
  const turns = conversations[key];
  const isSubmitting = !initialized || isClearing || turns.some(isPendingTurn);

  useEffect(() => {
    const requests = activeRequests.current;
    const unsubscribe = store.onReset(() => {
      abortRequests(requests);
      setDrafts(emptyDrafts());
    });
    return () => {
      unsubscribe();
      abortRequests(requests);
    };
  }, [store]);

  function updateDraft(question: string): void {
    setDrafts((previous) => ({ ...previous, [key]: question }));
  }

  async function handleSubmit(): Promise<void> {
    const question = drafts[key].trim();
    // store.update checks the revision under the history lock before any API call.
    if (!question || isClearing || activeRequests.current.has(key)) return;

    const turn: Turn = { id: crypto.randomUUID(), question, date: new Date().toISOString(), response: null, error: null };
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 600_000);
    const request = { controller, timeout };
    activeRequests.current.set(key, request);
    let generation: string | null = null;

    function isCurrentRequest(): boolean {
      return activeRequests.current.get(key) === request;
    }

    async function finishTurn(update: Pick<Turn, 'response' | 'error'>): Promise<boolean> {
      if (generation === null || !isCurrentRequest()) return false;
      const result = await store.update((current) => {
        const previous = current.conversations[key];
        if (!isCurrentRequest() || !previous.some((item) => item.id === turn.id)) return null;
        return {
          ...current.conversations,
          [key]: previous.map((item) => item.id === turn.id ? { ...item, ...update } : item),
        };
      }, generation);
      return result.applied;
    }

    try {
      await store.trackRequest(turn.id, async () => {
        let history: History = {};
        const started = await store.update((current) => {
          const previous = current.conversations[key];
          if (!isCurrentRequest() || previous.some(isPendingTurn)) return null;
          history = buildHistory(scope.mode, previous);
          return { ...current.conversations, [key]: [...previous, turn] };
        });
        generation = started.snapshot.generation;
        if (!started.applied || generation === null || !isCurrentRequest()) return;
        const response = await askQuestion(question, scope, history, controller.signal, generation);
        if (await finishTurn({ response, error: null }) && isCurrentRequest()) updateDraft('');
      });
    } catch (cause) {
      await finishTurn({ response: null, error: requestError(cause, controller.signal.aborted) });
    } finally {
      window.clearTimeout(timeout);
      if (isCurrentRequest()) activeRequests.current.delete(key);
    }
  }

  async function clearHistory(): Promise<void> {
    setIsClearing(true);
    abortRequests(activeRequests.current);
    setDrafts(emptyDrafts());
    try {
      await store.clear();
    } finally {
      setIsClearing(false);
    }
  }

  return { turns, question: drafts[key], storageWarning, isClearing, isSubmitting, updateDraft, handleSubmit, clearHistory };
}

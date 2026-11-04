import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { askQuestion } from './api';
import type { History } from './api';
import { AnswerPanel } from './components/AnswerPanel';
import { QuestionForm } from './components/QuestionForm';
import { EffortTabs, ModeTabs } from './components/Tabs';
import { createConversationStore } from './conversation-store';
import { buildHistory, isPendingTurn } from './conversations';
import type { Turn } from './conversations';
import { MODE_DESCRIPTIONS, MODE_LABELS } from './modes';
import type { Effort, Mode } from './modes';

interface ActiveRequest {
  controller: AbortController;
  timeout: number;
}

function abortRequests(requests: Map<string, ActiveRequest>): void {
  for (const request of requests.values()) {
    window.clearTimeout(request.timeout);
    request.controller.abort();
  }
  requests.clear();
}

function emptyDrafts(): Record<Effort, Record<Mode, string>> {
  return {
    low: { direct: '', steps: '', prompt: '', roles: '', compare: '' },
    max: { direct: '', steps: '', prompt: '', roles: '', compare: '' },
  };
}

function requestError(cause: unknown, aborted: boolean): string {
  if (aborted) return 'Время ожидания истекло. Попробуйте ещё раз.';
  if (cause instanceof TypeError) return 'Нет связи с сервером. Проверьте подключение и запуск бэкенда.';
  return cause instanceof Error ? cause.message : 'Не удалось получить ответ. Попробуйте ещё раз.';
}

export function App(): ReactElement {
  const [store] = useState(createConversationStore);
  const { conversations, warning: storageWarning } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [mode, setMode] = useState<Mode>('direct');
  const [effort, setEffort] = useState<Effort>('low');
  const [drafts, setDrafts] = useState(emptyDrafts);
  const [isClearing, setIsClearing] = useState(false);
  const activeRequests = useRef(new Map<string, ActiveRequest>());
  const turns = conversations[effort][mode];
  const isSubmitting = isClearing || turns.some(isPendingTurn);

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
    setDrafts((previous) => ({ ...previous, [effort]: { ...previous[effort], [mode]: question } }));
  }

  async function handleSubmit(): Promise<void> {
    const question = drafts[effort][mode].trim();
    const requestKey = `${effort}:${mode}`;
    if (!question || isClearing || activeRequests.current.has(requestKey)) return;

    const turn: Turn = { id: crypto.randomUUID(), question, date: new Date().toISOString(), response: null, error: null };
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 600_000);
    const request = { controller, timeout };
    activeRequests.current.set(requestKey, request);
    let generation: string | null = null;

    async function finishTurn(update: Partial<Turn>): Promise<boolean> {
      if (generation === null || activeRequests.current.get(requestKey) !== request) return false;
      const result = await store.update((current) => {
        const previous = current.conversations[effort][mode];
        if (activeRequests.current.get(requestKey) !== request || !previous.some((item) => item.id === turn.id)) return null;
        return {
          ...current.conversations,
          [effort]: {
            ...current.conversations[effort],
            [mode]: previous.map((item) => item.id === turn.id ? { ...item, ...update } : item),
          },
        };
      }, generation);
      return result.applied;
    }

    try {
      await store.trackRequest(turn.id, async () => {
        let history: History = {};
        const started = await store.update((current) => {
          const previous = current.conversations[effort][mode];
          if (activeRequests.current.get(requestKey) !== request || previous.some(isPendingTurn)) return null;
          history = buildHistory(mode, previous);
          return {
            ...current.conversations,
            [effort]: { ...current.conversations[effort], [mode]: [...previous, turn] },
          };
        });
        generation = started.snapshot.generation;
        if (!started.applied || generation === null || activeRequests.current.get(requestKey) !== request) return;
        const response = await askQuestion(question, mode, history, controller.signal, effort, generation);
        if (await finishTurn({ response, error: null }) && activeRequests.current.get(requestKey) === request) updateDraft('');
      });
    } catch (cause) {
      await finishTurn({ response: null, error: requestError(cause, controller.signal.aborted) });
    } finally {
      window.clearTimeout(timeout);
      if (activeRequests.current.get(requestKey) === request) activeRequests.current.delete(requestKey);
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

  return (
    <main className="page">
      <header className="page-header">
        <a className="brand" href="/" aria-label="Challenge — на главную">challenge<span aria-hidden="true"> / </span>ai</a>
        <button className="clear-history" type="button" onClick={clearHistory} disabled={isClearing}>Очистить историю</button>
      </header>
      <EffortTabs selected={effort} onSelect={setEffort} />
      <div role="tabpanel" id={`panel-effort-${effort}`} aria-labelledby={`tab-effort-${effort}`} tabIndex={0}>
        <p className="effort-description">
          Рассуждения включены · effort = <strong>{effort}</strong>.
          {' '}{effort === 'max' ? 'Больше времени и расхода токенов.' : 'Минимальная поддерживаемая интенсивность.'}
        </p>
        <ModeTabs selected={mode} onSelect={setMode} />
        <div
          className={`workspace${mode === 'compare' ? ' workspace-comparison' : ''}`}
          role="tabpanel"
          id={`panel-${mode}`}
          aria-labelledby={`tab-${mode}`}
          tabIndex={0}
        >
          <div className="intro">
            <p className="eyebrow">АЛГОРИТМЫ И АНАЛИТИКА</p>
            <h1>{MODE_LABELS[mode]}</h1>
            <p className="subtitle">{MODE_DESCRIPTIONS[mode]}</p>
            <p className="context-note">Отдельный диалог для каждой пары «рассуждения / подход». Предыдущая переписка передаётся модели.</p>
          </div>
          {storageWarning && <p className="storage-warning" role="alert">{storageWarning}</p>}
          <AnswerPanel turns={turns} />
          <QuestionForm
            question={drafts[effort][mode]}
            isSubmitting={isSubmitting}
            onQuestionChange={updateDraft}
            onSubmit={handleSubmit}
          />
        </div>
      </div>
      <footer className="page-footer">
        <span>История хранится только в этом браузере. Очистка удаляет все диалоги обоих режимов.</span>
        <span>Вопрос и история отправляются внешнему ИИ-сервису. Не указывайте секреты — ИИ может ошибаться.</span>
      </footer>
    </main>
  );
}

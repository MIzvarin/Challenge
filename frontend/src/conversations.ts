import { isAnswer, isRecord } from './api';
import type { Answer, History, Message, Stage } from './api';
import { CONVERSATION_SCOPES, conversationKey, conversationRecord } from './conversation-scope';
import type { ConversationKey, ConversationScope } from './conversation-scope';
import { EFFORTS, MODES, STAGE_LABELS, STRATEGIES } from './modes';
import type { Effort, Mode } from './modes';

export const LEGACY_STORAGE_KEY = 'challenge.conversations.v1';
export const PREVIOUS_STORAGE_KEY = 'challenge.conversations.v2';
export const STORAGE_KEY = 'challenge.conversations.v3';
export const HISTORY_STORAGE_KEYS = [STORAGE_KEY, PREVIOUS_STORAGE_KEY, LEGACY_STORAGE_KEY];

export interface Turn {
  id: string;
  question: string;
  date: string;
  response: Answer | null;
  error: string | null;
}

export type Profiles = Record<ConversationKey, Turn[]>;

export function emptyProfiles(): Profiles {
  return conversationRecord(() => []);
}

export function isPendingTurn(turn: Turn): boolean {
  return !turn.response && !turn.error;
}

function isTurn(turn: unknown, scope: ConversationScope): turn is Turn {
  if (!isRecord(turn)) return false;
  if (typeof turn.id !== 'string' || !turn.id) return false;
  if (typeof turn.question !== 'string' || !turn.question.trim()) return false;
  if (typeof turn.date !== 'string' || !Number.isFinite(Date.parse(turn.date))) return false;
  if (turn.error !== null && (typeof turn.error !== 'string' || !turn.error.trim())) return false;
  if (turn.response === null) return true;
  if (turn.error !== null || !isAnswer(turn.response, turn.question, scope.mode)) return false;
  if (scope.workspace === 'temperature') return turn.response.temperature === scope.temperature;
  return turn.response.temperature === undefined && (
    turn.response.effort === scope.effort || (scope.effort === 'low' && turn.response.effort === undefined)
  );
}

function restoreTurns(data: unknown, scope: ConversationScope, activeRequests: ReadonlySet<string>): Turn[] {
  if (!Array.isArray(data) || !data.every((turn): turn is Turn => isTurn(turn, scope))) throw new Error();
  if (new Set(data.map((turn) => turn.id)).size !== data.length) throw new Error();
  return data.map((turn) => {
    if (!isPendingTurn(turn) || activeRequests.has(turn.id)) return turn;
    return { ...turn, error: 'Запрос прерван перезагрузкой страницы. Отправьте вопрос ещё раз.' };
  });
}

function restoreLegacy(data: unknown, effort: Effort, activeRequests: ReadonlySet<string>): Partial<Profiles> {
  if (!isRecord(data) || Object.keys(data).length !== MODES.length) throw new Error();
  const conversations: Partial<Profiles> = {};
  for (const mode of MODES) {
    const scope = { workspace: 'reasoning', effort, mode } as const;
    conversations[conversationKey(scope)] = restoreTurns(data[mode], scope, activeRequests);
  }
  return conversations;
}

function readConversations(activeRequests: ReadonlySet<string>): Profiles {
  const conversations = emptyProfiles();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== null) {
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data) || Object.keys(data).length !== CONVERSATION_SCOPES.length) throw new Error();
    for (const scope of CONVERSATION_SCOPES) {
      const key = conversationKey(scope);
      conversations[key] = restoreTurns(data[key], scope, activeRequests);
    }
    return conversations;
  }

  const previous = localStorage.getItem(PREVIOUS_STORAGE_KEY);
  if (previous !== null) {
    const data: unknown = JSON.parse(previous);
    if (!isRecord(data) || Object.keys(data).length !== EFFORTS.length) throw new Error();
    for (const effort of EFFORTS) {
      Object.assign(conversations, restoreLegacy(data[effort], effort, activeRequests));
    }
    return conversations;
  }

  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy !== null) Object.assign(conversations, restoreLegacy(JSON.parse(legacy), 'low', activeRequests));
  return conversations;
}

export function loadConversations(activeRequests: ReadonlySet<string> = new Set()): { conversations: Profiles; warning: string | null } {
  try {
    return { conversations: readConversations(activeRequests), warning: null };
  } catch {
    return {
      conversations: emptyProfiles(),
      warning: 'Не удалось прочитать историю в браузере. Начните новую переписку или очистите историю.',
    };
  }
}

export function saveConversations(conversations: Profiles): string | null {
  try {
    const hasHistory = Object.values(conversations).some((turns) => turns.length > 0);
    if (hasHistory) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    // Remove the old copy only after the new history has been saved successfully.
    for (const key of [PREVIOUS_STORAGE_KEY, LEGACY_STORAGE_KEY]) localStorage.removeItem(key);
    return null;
  } catch {
    return 'Не удалось сохранить историю в браузере. Она доступна только до закрытия или обновления страницы.';
  }
}

function contextAnswer(answer: string, stages: Stage[]): string {
  if (stages.length === 0) return answer;
  return [
    ...stages.map((stage) => `${STAGE_LABELS[stage.name]}:\n${stage.content}`),
    `Итоговое решение:\n${answer}`,
  ].join('\n\n');
}

export function buildHistory(mode: Mode, turns: Turn[]): History {
  const history: History = {};
  for (const strategy of mode === 'compare' ? STRATEGIES : [mode]) {
    history[strategy] = turns.flatMap<Message>((turn) => {
      const result = turn.response?.results.find((result) => result.mode === strategy);
      if (!result?.answer || result.error) return [];
      return [
        { role: 'user', content: turn.question },
        { role: 'assistant', content: contextAnswer(result.answer, result.stages) },
      ];
    });
  }
  return history;
}

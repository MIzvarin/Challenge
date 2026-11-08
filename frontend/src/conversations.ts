import { isAnswer, isRecord } from './api';
import type { Answer, History, Message, Stage } from './api';
import { CONVERSATION_SCOPES, conversationKey, conversationRecord } from './conversation-scope';
import type { ConversationKey, ConversationScope } from './conversation-scope';
import { CHAT_MODELS, EFFORTS, MODES, STAGE_LABELS, STRATEGIES } from './modes';
import type { Effort, Mode } from './modes';

export const LEGACY_STORAGE_KEY = 'challenge.conversations.v1';
export const PREVIOUS_STORAGE_KEY = 'challenge.conversations.v2';
export const STORAGE_KEY = 'challenge.conversations.v3';
export const MODEL_STORAGE_KEY = 'challenge.model-comparisons.v1';
export const HISTORY_STORAGE_KEYS = [STORAGE_KEY, PREVIOUS_STORAGE_KEY, LEGACY_STORAGE_KEY, MODEL_STORAGE_KEY];
const ORIGINAL_SCOPES = CONVERSATION_SCOPES.filter((scope) => scope.workspace !== 'models');
const MODEL_SCOPES = CONVERSATION_SCOPES.filter((scope) => scope.workspace === 'models');

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
  if (scope.workspace === 'models') return turn.response.model === scope.model;
  if (turn.response.model !== undefined) return false;
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
    if (!isRecord(data) || Object.keys(data).length !== ORIGINAL_SCOPES.length) throw new Error();
    for (const scope of ORIGINAL_SCOPES) {
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
  let conversations = emptyProfiles();
  let warning: string | null = null;
  try {
    conversations = readConversations(activeRequests);
  } catch {
    warning = 'Не удалось прочитать историю в браузере. Начните новую переписку или очистите историю.';
  }
  try {
    const raw = localStorage.getItem(MODEL_STORAGE_KEY);
    if (raw !== null) {
      const data: unknown = JSON.parse(raw);
      if (!isRecord(data) || Object.keys(data).length !== CHAT_MODELS.length) throw new Error();
      const restored: Partial<Profiles> = {};
      for (const scope of MODEL_SCOPES) {
        restored[conversationKey(scope)] = restoreTurns(data[scope.model], scope, activeRequests);
      }
      Object.assign(conversations, restored);
    }
  } catch {
    warning = 'Не удалось прочитать историю моделей. Начните новую переписку или очистите историю.';
  }
  return { conversations, warning };
}

function hasScopeChanges(scopes: readonly ConversationScope[], conversations: Profiles, previous?: Profiles): boolean {
  if (!previous) return true;
  return scopes.some((scope) => {
    const key = conversationKey(scope);
    return conversations[key] !== previous[key];
  });
}

function writeHistory(key: string, history: Record<string, Turn[]>): void {
  if (Object.values(history).some((turns) => turns.length > 0)) {
    localStorage.setItem(key, JSON.stringify(history));
  } else {
    localStorage.removeItem(key);
  }
}

export function saveConversations(conversations: Profiles, previous?: Profiles): string | null {
  try {
    if (hasScopeChanges(ORIGINAL_SCOPES, conversations, previous)) {
      const original = Object.fromEntries(ORIGINAL_SCOPES.map((scope) => {
        const key = conversationKey(scope);
        return [key, conversations[key]];
      }));
      writeHistory(STORAGE_KEY, original);
      // Remove old copies only after successfully saving their replacement.
      for (const key of [PREVIOUS_STORAGE_KEY, LEGACY_STORAGE_KEY]) localStorage.removeItem(key);
    }
    if (hasScopeChanges(MODEL_SCOPES, conversations, previous)) {
      const models = Object.fromEntries(MODEL_SCOPES.map((scope) => [scope.model, conversations[conversationKey(scope)]]));
      writeHistory(MODEL_STORAGE_KEY, models);
    }
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

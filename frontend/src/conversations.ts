import { isAnswer, isRecord } from './api';
import type { Answer, History, Message, Stage } from './api';
import { EFFORTS, MODES, STAGE_LABELS, STRATEGIES } from './modes';
import type { Effort, Mode } from './modes';

export const LEGACY_STORAGE_KEY = 'challenge.conversations.v1';
export const STORAGE_KEY = 'challenge.conversations.v2';

export interface Turn {
  id: string;
  question: string;
  date: string;
  response: Answer | null;
  error: string | null;
}

export type Conversations = Record<Mode, Turn[]>;
export type Profiles = Record<Effort, Conversations>;

export function emptyConversations(): Conversations {
  return { direct: [], steps: [], prompt: [], roles: [], compare: [] };
}

export function emptyProfiles(): Profiles {
  return { low: emptyConversations(), max: emptyConversations() };
}

export function isPendingTurn(turn: Turn): boolean {
  return !turn.response && !turn.error;
}

function isTurn(turn: unknown, mode: Mode, effort: Effort): turn is Turn {
  if (!isRecord(turn)) return false;
  if (typeof turn.id !== 'string' || !turn.id) return false;
  if (typeof turn.question !== 'string' || !turn.question.trim()) return false;
  if (typeof turn.date !== 'string' || !Number.isFinite(Date.parse(turn.date))) return false;
  if (turn.error !== null && (typeof turn.error !== 'string' || !turn.error.trim())) return false;
  if (turn.response === null) return true;
  if (turn.error !== null || !isAnswer(turn.response, turn.question, mode)) return false;
  return turn.response.effort === effort || (effort === 'low' && turn.response.effort === undefined);
}

function restoreConversations(data: unknown, effort: Effort, activeRequests: ReadonlySet<string>): Conversations {
  if (!isRecord(data) || Object.keys(data).length !== MODES.length) throw new Error();
  const conversations = emptyConversations();
  for (const mode of MODES) {
    const turns = data[mode];
    if (!Array.isArray(turns) || !turns.every((turn): turn is Turn => isTurn(turn, mode, effort))) throw new Error();
    if (new Set(turns.map((turn) => turn.id)).size !== turns.length) throw new Error();
    conversations[mode] = turns.map((turn) => {
      if (!isPendingTurn(turn) || activeRequests.has(turn.id)) return turn;
      return { ...turn, error: 'Запрос прерван перезагрузкой страницы. Отправьте вопрос ещё раз.' };
    });
  }
  return conversations;
}

export function loadConversations(activeRequests: ReadonlySet<string> = new Set()): { conversations: Profiles; warning: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      const conversations = emptyProfiles();
      if (legacy) conversations.low = restoreConversations(JSON.parse(legacy), 'low', activeRequests);
      return { conversations, warning: null };
    }
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data) || Object.keys(data).length !== EFFORTS.length) throw new Error();
    const conversations = {
      low: restoreConversations(data.low, 'low', activeRequests),
      max: restoreConversations(data.max, 'max', activeRequests),
    };
    return { conversations, warning: null };
  } catch {
    return {
      conversations: emptyProfiles(),
      warning: 'Не удалось прочитать историю в браузере. Начните новую переписку или очистите историю.',
    };
  }
}

export function saveConversations(conversations: Profiles): string | null {
  try {
    const hasHistory = EFFORTS.some((effort) => MODES.some((mode) => conversations[effort][mode].length > 0));
    if (hasHistory) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    // Remove the old copy only after the new history has been saved successfully.
    localStorage.removeItem(LEGACY_STORAGE_KEY);
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

import { EFFORTS, STRATEGIES } from './modes';
import type { Effort, Mode, Strategy } from './modes';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export type History = Partial<Record<Strategy, Message[]>>;

export interface Stage {
  name: 'prompt' | 'analyst' | 'implementer';
  content: string;
  tokens: number;
}

export interface Result {
  mode: Strategy;
  answer: string | null;
  tokens: number | null;
  duration_ms: number;
  stages: Stage[];
  error: string | null;
}

export interface Answer {
  question: string;
  date: string;
  mode: Mode;
  // Absent only in local history imported from before effort controls existed.
  effort?: Effort;
  tokens: number | null;
  results: Result[];
}

const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EXPECTED_STAGES: Record<Strategy, readonly Stage['name'][]> = {
  direct: [],
  steps: [],
  prompt: ['prompt'],
  roles: ['analyst', 'implementer'],
};

export function isRecord(data: unknown): data is Record<string, unknown> {
  return Boolean(data) && typeof data === 'object' && !Array.isArray(data);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStage(data: unknown, name: Stage['name']): data is Stage {
  return isRecord(data) && Object.keys(data).length === 3 && data.name === name &&
    isText(data.content) && isCount(data.tokens);
}

function isResult(data: unknown, mode: Strategy): data is Result {
  if (!isRecord(data) || Object.keys(data).length !== 6 || data.mode !== mode) return false;
  if (!isCount(data.duration_ms) || !Array.isArray(data.stages)) return false;

  const stages = data.stages;
  const names = EXPECTED_STAGES[mode];
  if (stages.length > names.length || !stages.every(
    (stage, index): stage is Stage => isStage(stage, names[index]),
  )) return false;

  if (data.error !== null) return isText(data.error) && data.answer === null && data.tokens === null;
  return isText(data.answer) && isCount(data.tokens) && stages.length === names.length &&
    data.tokens >= stages.reduce((sum, stage) => sum + stage.tokens, 0);
}

export function isAnswer(data: unknown, question: string, mode: Mode, effort?: Effort): data is Answer {
  if (!isRecord(data)) return false;
  const hasEffort = 'effort' in data;
  if (Object.keys(data).length !== (hasEffort ? 6 : 5)) return false;
  if (effort !== undefined && data.effort !== effort) return false;
  if (hasEffort && !EFFORTS.includes(data.effort as Effort)) return false;
  if (data.question !== question || !isText(question) || data.mode !== mode) return false;
  if (typeof data.date !== 'string' || !ISO_DATETIME_PATTERN.test(data.date) || !Number.isFinite(Date.parse(data.date))) return false;

  const modes = mode === 'compare' ? STRATEGIES : [mode];
  if (!Array.isArray(data.results)) return false;
  const results = data.results;
  if (results.length !== modes.length || !results.every(
    (result, index): result is Result => isResult(result, modes[index]),
  )) return false;

  let total = 0;
  for (const result of results) {
    if (result.tokens === null) return mode === 'compare' && data.tokens === null;
    total += result.tokens;
  }
  return isCount(data.tokens) && data.tokens === total;
}

export async function askQuestion(
  question: string, mode: Mode, history: History, signal: AbortSignal, effort: Effort = 'low',
  conversationId?: string,
): Promise<Answer> {
  const response = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, mode, effort, history, conversation_id: conversationId }),
    signal,
  });

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('Сервер вернул некорректный ответ. Проверьте, запущен ли бэкенд.');
  }

  if (!response.ok) {
    const detail = isRecord(data) ? data.detail : null;
    throw new Error(typeof detail === 'string' ? detail : 'Не удалось получить ответ. Попробуйте позже.');
  }

  if (!isAnswer(data, question, mode, effort)) {
    throw new Error('Сервер вернул некорректный ответ. Попробуйте ещё раз.');
  }
  return data;
}

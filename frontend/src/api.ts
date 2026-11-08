import { CHAT_MODELS, EFFORTS, STRATEGIES, TEMPERATURES } from './modes';
import type { ChatModel, Effort, Mode, Strategy, Temperature } from './modes';
import type { ConversationScope } from './conversation-scope';
import { compareSum, isCost, samePricing } from './cost';
import type { Cost } from './cost';
export type { Cost } from './cost';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export type History = Partial<Record<Strategy, Message[]>>;

export interface Stage {
  name: 'prompt' | 'analyst' | 'implementer';
  content: string;
  tokens: number;
  // Absent only in history saved before cost metadata existed.
  cost?: Cost | null;
}

export interface Result {
  mode: Strategy;
  answer: string | null;
  tokens: number | null;
  cost?: Cost | null;
  duration_ms: number;
  stages: Stage[];
  error: string | null;
}

interface BaseAnswer {
  question: string;
  date: string;
  mode: Mode;
  tokens: number | null;
  cost?: Cost | null;
  results: Result[];
}

export interface ReasoningAnswer extends BaseAnswer {
  model?: never;
  // Absent only in local history imported from before effort controls existed.
  effort?: Effort;
  temperature?: never;
}

export interface TemperatureAnswer extends BaseAnswer {
  model?: never;
  mode: 'direct';
  effort: null;
  temperature: Temperature;
}

export interface ModelAnswer extends BaseAnswer {
  model: ChatModel;
  mode: 'direct';
  effort: null;
  temperature?: never;
}

export type Answer = ReasoningAnswer | TemperatureAnswer | ModelAnswer;

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

function hasCost(data: Record<string, unknown>, legacy: boolean): boolean {
  return 'cost' in data ? data.cost === null || isCost(data.cost) : legacy;
}

function isStage(data: unknown, name: Stage['name'], legacy: boolean): data is Stage {
  return isRecord(data) && Object.keys(data).length === (('cost' in data) ? 4 : 3) &&
    hasCost(data, legacy) && data.name === name && isText(data.content) && isCount(data.tokens);
}

function isResult(data: unknown, mode: Strategy, legacy: boolean): data is Result {
  if (!isRecord(data) || Object.keys(data).length !== (('cost' in data) ? 7 : 6) ||
      !hasCost(data, legacy) || data.mode !== mode) return false;
  if (!isCount(data.duration_ms) || !Array.isArray(data.stages)) return false;

  const stages = data.stages;
  const names = EXPECTED_STAGES[mode];
  if (stages.length > names.length || !stages.every(
    (stage, index): stage is Stage => isStage(stage, names[index], legacy),
  )) return false;

  const cost = data.cost as Cost | null | undefined;
  const stageCosts = stages.flatMap((stage) => stage.cost ? [stage.cost] : []);
  if (!samePricing([...(cost ? [cost] : []), ...stageCosts])) return false;
  if (cost && (stages.some((stage) => !stage.cost) || compareSum(cost.amount, stageCosts.map((c) => c.amount)) < 0)) return false;
  if (data.error !== null) return !cost && isText(data.error) && data.answer === null && data.tokens === null;
  return isText(data.answer) && isCount(data.tokens) && stages.length === names.length &&
    data.tokens >= stages.reduce((sum, stage) => sum + stage.tokens, 0);
}

export function isAnswer(data: unknown, question: string, mode: Mode, expected?: ConversationScope, legacy = false): data is Answer {
  if (!isRecord(data)) return false;
  const hasEffort = 'effort' in data;
  const hasTemperature = 'temperature' in data;
  const hasModel = 'model' in data;
  let fieldCount = 5;
  if (hasEffort) fieldCount = 6;
  if (hasTemperature || hasModel) fieldCount = 7;
  if ('cost' in data) fieldCount += 1;
  if (!hasCost(data, legacy)) return false;
  if (Object.keys(data).length !== fieldCount) return false;
  if (hasModel) {
    if (hasTemperature || data.mode !== 'direct' || data.effort !== null || !CHAT_MODELS.includes(data.model as ChatModel)) return false;
  } else if (hasTemperature) {
    if (data.mode !== 'direct' || data.effort !== null || !TEMPERATURES.includes(data.temperature as Temperature)) return false;
  } else if (hasEffort && !EFFORTS.includes(data.effort as Effort)) return false;
  if (expected?.workspace === 'models' && (!hasModel || data.model !== expected.model)) return false;
  if (expected?.workspace === 'temperature' && (hasModel || !hasTemperature || data.temperature !== expected.temperature)) return false;
  if (expected?.workspace === 'reasoning' && (hasModel || hasTemperature || data.effort !== expected.effort)) return false;
  if (data.question !== question || !isText(question) || data.mode !== mode) return false;
  if (typeof data.date !== 'string' || !ISO_DATETIME_PATTERN.test(data.date) || !Number.isFinite(Date.parse(data.date))) return false;

  const modes = mode === 'compare' ? STRATEGIES : [mode];
  if (!Array.isArray(data.results)) return false;
  const results = data.results;
  if (results.length !== modes.length || !results.every(
    (result, index): result is Result => isResult(result, modes[index], legacy),
  )) return false;
  if (hasModel && results[0].error !== null) return false;

  const cost = data.cost as Cost | null | undefined;
  const resultCosts = results.flatMap((result) => result.cost ? [result.cost] : []);
  const allCosts = [...(cost ? [cost] : []), ...resultCosts, ...results.flatMap((result) => result.stages.flatMap((stage) => stage.cost ? [stage.cost] : []))];
  if (!samePricing(allCosts)) return false;
  if (cost) {
    if (resultCosts.length !== results.length || compareSum(cost.amount, resultCosts.map((c) => c.amount)) !== 0) return false;
  } else if (resultCosts.length === results.length) return false;

  let total = 0;
  for (const result of results) {
    if (result.tokens === null) return mode === 'compare' && data.tokens === null;
    total += result.tokens;
  }
  return isCount(data.tokens) && data.tokens === total;
}

export async function askQuestion(
  question: string, scope: ConversationScope, history: History, signal: AbortSignal,
  conversationId?: string,
): Promise<Answer> {
  let settings: { model: ChatModel } | { mode: Mode; temperature: Temperature } | { mode: Mode; effort: Effort };
  if (scope.workspace === 'models') settings = { model: scope.model };
  else if (scope.workspace === 'temperature') settings = { mode: scope.mode, temperature: scope.temperature };
  else settings = { mode: scope.mode, effort: scope.effort };
  const response = await fetch(scope.workspace === 'models' ? '/api/ask-models' : '/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, ...settings, history, conversation_id: conversationId }),
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

  if (!isAnswer(data, question, scope.mode, scope)) {
    throw new Error('Сервер вернул некорректный ответ. Попробуйте ещё раз.');
  }
  return data;
}

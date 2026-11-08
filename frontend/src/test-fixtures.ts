import type { Answer, Cost, ModelAnswer, ReasoningAnswer, Result, Stage, TemperatureAnswer } from './api';
import type { ConversationScope } from './conversation-scope';
import { MODES, STRATEGIES } from './modes';
import type { ChatModel, Effort, Mode, Strategy, Temperature } from './modes';
import type { Turn } from './conversations';

export function emptyConversations(): Record<Mode, Turn[]> {
  return Object.fromEntries(MODES.map((mode): [Mode, Turn[]] => [mode, []])) as Record<Mode, Turn[]>;
}

export function makeResult(mode: Strategy, answer = 'Ответ модели'): Result {
  let stages: Stage[] = [];
  if (mode === 'prompt') {
    stages = [{ name: 'prompt', content: 'Готовый промпт', tokens: 20, cost: null }];
  } else if (mode === 'roles') {
    stages = [
      { name: 'analyst', content: 'Разбор задачи', tokens: 20, cost: null },
      { name: 'implementer', content: 'Реализация', tokens: 30, cost: null },
    ];
  }
  return {
    mode, answer, tokens: 142, cost: null, duration_ms: 1250, error: null, stages,
  };
}

export function makeAnswer(question = 'Привет', mode: Mode = 'direct', effort: Effort = 'low'): ReasoningAnswer {
  const results = (mode === 'compare' ? STRATEGIES : [mode]).map((strategy) => makeResult(strategy));
  return { question, date: '2026-11-03T12:30:00Z', mode, effort, tokens: 142 * results.length, cost: null, results };
}

export function makeTemperatureAnswer(question = 'Привет', temperature: Temperature = 0.7): TemperatureAnswer {
  return { ...makeAnswer(question), mode: 'direct', effort: null, temperature };
}

export function makeModelAnswer(question = 'Привет', model: ChatModel = 'kimi-k2.7-code'): ModelAnswer {
  return { ...makeAnswer(question), mode: 'direct', effort: null, model };
}

export function makeScopedAnswer(question: string, scope: ConversationScope): Answer {
  switch (scope.workspace) {
    case 'reasoning':
      return makeAnswer(question, scope.mode, scope.effort);
    case 'temperature':
      return makeTemperatureAnswer(question, scope.temperature);
    case 'models':
      return makeModelAnswer(question, scope.model);
  }
}

export function makeCost(amount = '0.001446'): Cost {
  return { amount, currency: 'USD', pricing_version: 'opencode-go-2026-11-08-v1', source: 'https://opencode.ai/docs/go/#usage-limits' };
}

export function withCosts<T extends Answer>(answer: T): T {
  const copy = structuredClone(answer);
  copy.cost = makeCost(`0.00${copy.results.length}`);
  for (const result of copy.results) {
    result.cost = makeCost('0.001');
    for (const stage of result.stages) stage.cost = makeCost('0.0001');
  }
  return copy;
}

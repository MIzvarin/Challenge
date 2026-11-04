import type { Answer, Result, Stage } from './api';
import { STRATEGIES } from './modes';
import type { Effort, Mode, Strategy } from './modes';

export function makeResult(mode: Strategy, answer = 'Ответ модели'): Result {
  let stages: Stage[] = [];
  if (mode === 'prompt') {
    stages = [{ name: 'prompt', content: 'Готовый промпт', tokens: 20 }];
  } else if (mode === 'roles') {
    stages = [
      { name: 'analyst', content: 'Разбор задачи', tokens: 20 },
      { name: 'implementer', content: 'Реализация', tokens: 30 },
    ];
  }
  return {
    mode, answer, tokens: 142, duration_ms: 1250, error: null, stages,
  };
}

export function makeAnswer(question = 'Привет', mode: Mode = 'direct', effort: Effort = 'low'): Answer {
  const results = (mode === 'compare' ? STRATEGIES : [mode]).map((strategy) => makeResult(strategy));
  return { question, date: '2026-11-03T12:30:00Z', mode, effort, tokens: 142 * results.length, results };
}

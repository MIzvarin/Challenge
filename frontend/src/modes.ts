export const STRATEGIES = ['direct', 'steps', 'prompt', 'roles'] as const;
export const MODES = [...STRATEGIES, 'compare'] as const;
export type Strategy = typeof STRATEGIES[number];
export type Mode = typeof MODES[number];
export const EFFORTS = ['low', 'max'] as const;
export type Effort = typeof EFFORTS[number];

export const EFFORT_LABELS: Record<Effort, string> = {
  low: 'Минимум рассуждений',
  max: 'Максимум рассуждений',
};

export const MODE_LABELS: Record<Mode, string> = {
  direct: 'Прямой ответ',
  steps: 'Пошаговое решение',
  prompt: 'Промпт → решение',
  roles: 'Команда ролей',
  compare: 'Сравнение',
};

export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  direct: 'Ваш вопрос отправляется модели без дополнительных инструкций по решению. Ответ — на русском языке.',
  steps: 'Подход, основные шаги, проверка и итоговый ответ с объяснением.',
  prompt: 'Модель составляет промпт под вашу задачу, а затем решает её по этому промпту. Два обращения к модели.',
  roles: 'Аналитик разбирает задачу, исполнитель решает, критик проверяет и исправляет. Три обращения к модели.',
  compare: 'Одна задача — четыре независимых подхода. Семь обращений к модели: больше времени и расхода токенов.',
};

export const STAGE_LABELS = {
  prompt: 'Составленный промпт',
  analyst: 'Аналитик',
  implementer: 'Исполнитель',
} as const;

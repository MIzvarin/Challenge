export const STRATEGIES = ['direct', 'steps', 'prompt', 'roles'] as const;
export const MODES = [...STRATEGIES, 'compare'] as const;
export type Strategy = typeof STRATEGIES[number];
export type Mode = typeof MODES[number];
export const EFFORTS = ['low', 'max'] as const;
export type Effort = typeof EFFORTS[number];
export const TEMPERATURES = [0, 0.7, 1.2] as const;
export type Temperature = typeof TEMPERATURES[number];
export const TEMPERATURE_LABELS: Record<Temperature, string> = {
  0: 'Низкая',
  0.7: 'Средняя',
  1.2: 'Высокая',
};
export const CHAT_MODELS = ['kimi-k2.7-code', 'grok-4.7', 'gpt-6-luna'] as const;
export type ChatModel = typeof CHAT_MODELS[number];
export const MODEL_LABELS: Record<ChatModel, string> = {
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'grok-4.7': 'Grok 4.7',
  'gpt-6-luna': 'GPT‑6 Luna',
};
export const WORKSPACE_LABELS = { reasoning: 'Подходы к решению', temperature: 'Температура', models: 'Модели' } as const;
export type Workspace = keyof typeof WORKSPACE_LABELS;

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

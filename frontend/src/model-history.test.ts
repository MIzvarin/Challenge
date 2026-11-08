import { expect, it } from 'vitest';
import { buildHistory, emptyProfiles } from './conversations';
import type { Turn } from './conversations';
import { conversationKey } from './conversation-scope';
import { CHAT_MODELS } from './modes';
import { makeModelAnswer } from './test-fixtures';

it('builds complete direct history only from successful turns of the selected model scope', () => {
  const profiles = emptyProfiles();
  for (const model of CHAT_MODELS) {
    const key = conversationKey({ workspace: 'models', model, mode: 'direct' });
    const question = `${model} ${'Длинный вопрос'.repeat(2000)}`;
    const turn: Turn = { id: model, question, date: '2026-11-08T12:00:00Z', response: makeModelAnswer(question, model), error: null };
    profiles[key] = [turn, { ...turn, id: `${model}-failed`, response: null, error: 'Ошибка' }];
  }
  for (const model of CHAT_MODELS) {
    const turns = profiles[conversationKey({ workspace: 'models', model, mode: 'direct' })];
    expect(buildHistory('direct', turns)).toEqual({ direct: [
      { role: 'user', content: turns[0].question }, { role: 'assistant', content: 'Ответ модели' },
    ] });
  }
});

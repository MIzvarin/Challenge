import { CHAT_MODELS, EFFORTS, MODES, TEMPERATURES } from './modes';
import type { ChatModel, Effort, Mode, Temperature } from './modes';

export type ConversationScope =
  | { workspace: 'reasoning'; effort: Effort; mode: Mode }
  | { workspace: 'temperature'; temperature: Temperature; mode: 'direct' }
  | { workspace: 'models'; model: ChatModel; mode: 'direct' };

export type ConversationKey = `reasoning:${Effort}:${Mode}` | `temperature:${Temperature}:direct` | `models:${ChatModel}:direct`;

export function conversationKey(scope: ConversationScope): ConversationKey {
  if (scope.workspace === 'models') return `models:${scope.model}:direct`;
  return scope.workspace === 'reasoning'
    ? `reasoning:${scope.effort}:${scope.mode}`
    : `temperature:${scope.temperature}:direct`;
}

export const CONVERSATION_SCOPES: readonly ConversationScope[] = [
  ...EFFORTS.flatMap((effort) => MODES.map((mode): ConversationScope => ({ workspace: 'reasoning', effort, mode }))),
  ...TEMPERATURES.map((temperature): ConversationScope => ({ workspace: 'temperature', temperature, mode: 'direct' })),
  ...CHAT_MODELS.map((model): ConversationScope => ({ workspace: 'models', model, mode: 'direct' })),
];

export function conversationRecord<T>(create: () => T): Record<ConversationKey, T> {
  return Object.fromEntries(CONVERSATION_SCOPES.map((scope) => [conversationKey(scope), create()])) as Record<ConversationKey, T>;
}

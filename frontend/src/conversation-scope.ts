import { EFFORTS, MODES, TEMPERATURES } from './modes';
import type { Effort, Mode, Temperature } from './modes';

export type ConversationScope =
  | { workspace: 'reasoning'; effort: Effort; mode: Mode }
  | { workspace: 'temperature'; temperature: Temperature; mode: 'direct' };

export type ConversationKey = `reasoning:${Effort}:${Mode}` | `temperature:${Temperature}:direct`;

export function conversationKey(scope: ConversationScope): ConversationKey {
  return scope.workspace === 'reasoning'
    ? `reasoning:${scope.effort}:${scope.mode}`
    : `temperature:${scope.temperature}:direct`;
}

export const CONVERSATION_SCOPES: readonly ConversationScope[] = [
  ...EFFORTS.flatMap((effort) => MODES.map((mode): ConversationScope => ({ workspace: 'reasoning', effort, mode }))),
  ...TEMPERATURES.map((temperature): ConversationScope => ({ workspace: 'temperature', temperature, mode: 'direct' })),
];

export function conversationRecord<T>(create: () => T): Record<ConversationKey, T> {
  return Object.fromEntries(CONVERSATION_SCOPES.map((scope) => [conversationKey(scope), create()])) as Record<ConversationKey, T>;
}

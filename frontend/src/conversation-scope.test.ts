import { describe, expect, it } from 'vitest';
import { CONVERSATION_SCOPES, conversationKey, conversationRecord } from './conversation-scope';
import type { ConversationScope } from './conversation-scope';

describe('conversation scopes', () => {
  it('addresses exactly thirteen distinct conversations', () => {
    const keys = CONVERSATION_SCOPES.map(conversationKey);
    expect(keys).toHaveLength(13);
    expect(new Set(keys).size).toBe(13);
    expect(Object.keys(conversationRecord(() => []))).toEqual(keys);
    expect(conversationKey({ workspace: 'temperature', temperature: 0.0, mode: 'direct' })).toBe('temperature:0:direct');
  });

  it('rejects incompatible settings at compile time', () => {
    // @ts-expect-error Temperature conversations only support direct answers.
    const invalidMode: ConversationScope = { workspace: 'temperature', temperature: 0, mode: 'compare' };
    // @ts-expect-error Effort is not a temperature setting.
    const invalidEffort: ConversationScope = { workspace: 'temperature', temperature: 0, mode: 'direct', effort: 'low' };
    // @ts-expect-error Arbitrary temperatures are not supported.
    const invalidTemperature: ConversationScope = { workspace: 'temperature', temperature: 0.5, mode: 'direct' };
    expect([invalidMode, invalidEffort, invalidTemperature]).toHaveLength(3);
  });
});

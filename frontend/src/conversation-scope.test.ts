import { describe, expect, it } from 'vitest';
import { CONVERSATION_SCOPES, conversationKey, conversationRecord } from './conversation-scope';
import type { ConversationScope } from './conversation-scope';

describe('conversation scopes', () => {
  it('addresses sixteen distinct conversations while preserving the original thirteen keys', () => {
    const keys = CONVERSATION_SCOPES.map(conversationKey);
    expect(keys).toHaveLength(16);
    expect(new Set(keys).size).toBe(16);
    expect(keys.filter((key) => !key.startsWith('models:'))).toHaveLength(13);
    expect(keys.filter((key) => key.startsWith('models:'))).toEqual([
      'models:kimi-k2.7-code:direct', 'models:grok-4.7:direct', 'models:gpt-6-luna:direct',
    ]);
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

import '@testing-library/jest-dom/vitest';
import { act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { createTestLocks } from './test-locks';

// Node 26 also exposes localStorage; tests must use the jsdom browser's storage.
const { jsdom } = globalThis as typeof globalThis & { jsdom: { window: Window } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: jsdom.window.localStorage });

beforeEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: createTestLocks() });
});

afterEach(async () => {
  cleanup();
  await act(async () => {});
});

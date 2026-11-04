export function createTestLocks(): LockManager {
  const queues = new Map<string, Promise<unknown>>();
  const held = new Set<string>();

  function request<T>(name: string, callback: (lock: Lock) => T | PromiseLike<T>): Promise<T> {
    const previous = queues.get(name) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
      held.add(name);
      try {
        return await callback({ name, mode: 'exclusive' } as Lock);
      } finally {
        held.delete(name);
      }
    });
    queues.set(name, result);
    return result;
  }

  async function query(): Promise<LockManagerSnapshot> {
    return { held: [...held].map((name) => ({ name, mode: 'exclusive' })), pending: [] };
  }

  return { request, query } as LockManager;
}

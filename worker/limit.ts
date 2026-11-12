// A small weighted semaphore. A Workers invocation may wait on response headers from only 6 connections at a time;
// later fetches queue silently, with no per-request limit (https://developers.cloudflare.com/workers/platform/limits/).
// A timeout created before a request leaves that queue measures the queue too, so six hung origins would make every
// probe behind them time out. Work runs here inside a slot, and each check or send creates its timeout only once it
// holds one, so what it measures is its own request.
export interface Limiter {
  /** Runs fn once `weight` slots are free (a DNS check holds two: its A and AAAA lookups run together). */
  run<T>(fn: () => Promise<T>, weight?: number): Promise<T>;
}

export function createLimiter(capacity: number): Limiter {
  let used = 0;
  const waiting: { readonly weight: number; readonly start: () => void }[] = [];
  const pump = (): void => {
    for (let next = waiting[0]; next !== undefined && used + next.weight <= capacity; next = waiting[0]) {
      waiting.shift();
      used += next.weight;
      next.start();
    }
  };
  return {
    run<T>(fn: () => Promise<T>, weight = 1): Promise<T> {
      const slots = Math.min(Math.max(1, weight), capacity);
      return new Promise<T>((resolve, reject) => {
        waiting.push({
          weight: slots,
          start: () => {
            fn().then(resolve, reject).finally(() => {
              used -= slots;
              pump();
            });
          },
        });
        pump();
      });
    },
  };
}

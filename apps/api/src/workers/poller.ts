import type { Logger } from '../lib/logger.js';

export interface Poller {
  stop(): Promise<void>;
}

export interface PollerOptions {
  name: string;
  intervalMs: number;
  logger: Logger;
  /** When a run processes a full batch, poll again immediately to drain a backlog. */
  batchSize?: number;
}

/**
 * Runs `task` in a loop without overlap. Errors are logged and the loop keeps
 * going (with the normal interval as a natural backoff). `stop()` waits for the
 * current iteration so shutdown never interrupts a half-finished batch.
 */
export function startPoller(
  task: () => Promise<number>,
  { name, intervalMs, logger, batchSize }: PollerOptions,
): Poller {
  let running = true;
  let wake: (() => void) | undefined;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const loop = (async () => {
    while (running) {
      let processed = 0;
      try {
        processed = await task();
      } catch (error) {
        logger.error({ err: error, poller: name }, 'Poller iteration failed');
      }
      const drainAgain = batchSize !== undefined && processed >= batchSize;
      if (running && !drainAgain) await sleep(intervalMs);
    }
  })();

  return {
    async stop() {
      running = false;
      wake?.();
      await loop;
    },
  };
}

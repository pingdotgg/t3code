import nodeFs from "node:fs";
import { Effect, Queue, Stream } from "effect";

export interface WatchFileWithStatPollingOptions {
  readonly filePath: string;
  readonly pollIntervalMs?: number;
}

/**
 * Expose Node's stat-based file poller as a scoped Effect stream.
 *
 * `fs.watchFile` uses libuv timers, so it remains a reliable fallback when
 * the Effect scheduler is under load and prompt fiber wake-ups are not
 * guaranteed.
 */
export const watchFileWithStatPolling = ({
  filePath,
  pollIntervalMs = 100,
}: WatchFileWithStatPollingOptions) =>
  Stream.callback<void>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const onChange = () => {
          Queue.offerUnsafe(queue, undefined);
        };
        nodeFs.watchFile(filePath, { interval: pollIntervalMs }, onChange);
        return onChange;
      }),
      (onChange) =>
        Effect.sync(() => {
          nodeFs.unwatchFile(filePath, onChange);
        }),
    ),
  );

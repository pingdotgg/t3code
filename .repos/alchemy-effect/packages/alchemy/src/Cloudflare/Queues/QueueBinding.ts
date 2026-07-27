import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Queue } from "./Queue.ts";
import { SendError } from "./QueueTypes.ts";

/**
 * Shared scaffolding for the Worker-binding implementations of the Queue
 * services.
 *
 * Resolves the {@link WorkerEnvironment} and host {@link Worker}, registers
 * the `queue` binding at deploy time, then delegates to `makeClient` with the
 * shared {@link makeQueueHelpers} to build the producer client.
 */
export const makeQueueBinding = <Client>(options: {
  makeClient: (helpers: ReturnType<typeof makeQueueHelpers>) => Client;
}) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (queue: Queue) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${queue}`({
          bindings: [
            {
              type: "queue",
              name: queue.LogicalId,
              queueName: queue.queueName,
            },
          ],
        });
      }

      return options.makeClient(makeQueueHelpers(env, queue));
    });
  });

/** Primitives shared by the Worker-binding producer clients. */
export const makeQueueHelpers = (env: Record<string, any>, queue: Queue) => {
  const raw = Effect.sync(
    () => (env as Record<string, runtime.Queue<unknown>>)[queue.LogicalId]!,
  );

  const tryPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, SendError> =>
    Effect.tryPromise({
      try: fn,
      catch: (error: any) =>
        new SendError({
          message: error?.message ?? "Unknown queue error",
          cause: error,
        }),
    });

  const use = <T>(
    fn: (raw: runtime.Queue<unknown>) => Promise<T>,
  ): Effect.Effect<T, SendError> =>
    raw.pipe(Effect.flatMap((raw) => tryPromise(() => fn(raw))));

  return { raw, use, tryPromise };
};

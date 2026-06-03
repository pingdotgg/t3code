import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Queue } from "./Queue.ts";

export interface QueueSender {
  raw: Effect.Effect<any, never, RuntimeContext>;
  send(
    body: unknown,
    options?: { contentType?: "json" | "text" },
  ): Effect.Effect<void, QueueSendError, RuntimeContext>;
  sendBatch(
    messages: ReadonlyArray<{
      body: unknown;
      contentType?: "json" | "text";
    }>,
  ): Effect.Effect<void, QueueSendError, RuntimeContext>;
}

import * as Data from "effect/Data";

export class QueueSendError extends Data.TaggedError("QueueSendError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Binding service that turns a {@link Queue} resource into a typed
 * {@link QueueSender} you can call from a Worker's runtime Effect.
 *
 * @section Sending Messages
 * Bind the queue in the Worker's init phase, then use `send` for
 * single messages or `sendBatch` for many messages in one call.
 * Messages can be any JSON-serializable value.
 *
 * @example Producer route
 * ```typescript
 * const queue = yield* Cloudflare.QueueBinding.bind(Queue);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     yield* queue.send({ text: "hi", sentAt: Date.now() });
 *     return HttpServerResponse.empty({ status: 202 });
 *   }),
 * };
 * ```
 *
 * @example Sending a batch
 * ```typescript
 * yield* queue.sendBatch([
 *   { body: { event: "click", id: 1 } },
 *   { body: { event: "click", id: 2 } },
 *   { body: "raw text", contentType: "text" },
 * ]);
 * ```
 *
 * Provide {@link QueueBindingLive} in the worker's runtime layer to
 * resolve the underlying Cloudflare queue at request time.
 */
export class QueueBinding extends Binding.Service<
  QueueBinding,
  (queue: Queue) => Effect.Effect<QueueSender>
>()("Cloudflare.Queue") {}

export const QueueBindingLive = Layer.effect(
  QueueBinding,
  Effect.gen(function* () {
    const bind = yield* QueueBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (queue: Queue) {
      yield* bind(queue);
      const raw = Effect.sync(
        () => (env as Record<string, any>)[queue.LogicalId],
      );

      const tryPromise = <T>(
        fn: () => Promise<T>,
      ): Effect.Effect<T, QueueSendError> =>
        Effect.tryPromise({
          try: fn,
          catch: (error: any) =>
            new QueueSendError({
              message: error?.message ?? "Unknown queue error",
              cause: error,
            }),
        });

      return {
        raw,
        send: (body: unknown, options?: { contentType?: "json" | "text" }) =>
          raw.pipe(
            Effect.flatMap((q) => tryPromise(() => q.send(body, options))),
          ),
        sendBatch: (
          messages: ReadonlyArray<{
            body: unknown;
            contentType?: "json" | "text";
          }>,
        ) =>
          raw.pipe(
            Effect.flatMap((q) =>
              tryPromise(() =>
                q.sendBatch(
                  messages.map((m) => ({
                    body: m.body,
                    ...(m.contentType ? { contentType: m.contentType } : {}),
                  })),
                ),
              ),
            ),
          ),
      } satisfies QueueSender;
    });
  }),
);

export class QueueBindingPolicy extends Binding.Policy<
  QueueBindingPolicy,
  (queue: Queue) => Effect.Effect<void>
>()("Cloudflare.Queue") {}

export const QueueBindingPolicyLive = QueueBindingPolicy.layer.succeed(
  Effect.fnUntraced(function* (host: ResourceLike, queue: Queue) {
    if (isWorker(host)) {
      yield* host.bind`${queue}`({
        bindings: [
          {
            type: "queue",
            name: queue.LogicalId,
            queueName: queue.queueName,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`QueueBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);

import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Queue } from "./Queue.ts";
import type { SendError, SendMessage, SendOptions } from "./QueueTypes.ts";

/**
 * Binding service that turns a {@link Queue} resource into a typed
 * {@link WriteQueueClient} you can call from a Worker's runtime Effect.
 *
 * The Cloudflare Worker queue binding is producer-only — `send` for a
 * single message and `sendBatch` for many in one call. Messages can be
 * any JSON-serializable value.
 * @binding
 * @product Queues
 * @category Storage & Databases
 * @section Sending Messages
 * @example Producer route
 * ```typescript
 * const queue = yield* Cloudflare.Queues.WriteQueue(Queue);
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
 * Provide {@link WriteQueueBinding} (native Worker binding) or
 * {@link WriteQueueHttp} (scoped HTTP token) in the worker's runtime
 * layer to resolve the underlying queue at request time.
 *
 * `WriteQueue` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.Queues.WriteQueue(queue)`.
 */
export interface WriteQueue extends Binding.Service<
  WriteQueue,
  "Cloudflare.Queues.WriteQueue",
  (queue: Queue) => Effect.Effect<WriteQueueClient>
> {}

export const WriteQueue = Binding.Service<WriteQueue>(
  "Cloudflare.Queues.WriteQueue",
);

export interface WriteQueueClient {
  raw: Effect.Effect<runtime.Queue<unknown>, never, RuntimeContext>;
  send(
    body: unknown,
    options?: SendOptions,
  ): Effect.Effect<void, SendError, RuntimeContext>;
  sendBatch(
    messages: ReadonlyArray<SendMessage>,
  ): Effect.Effect<void, SendError, RuntimeContext>;
}

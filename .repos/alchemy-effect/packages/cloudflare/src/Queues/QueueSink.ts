import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import type { Queue } from "./Queue.ts";
import type { SendError } from "./QueueTypes.ts";

/**
 * Binding service that exposes a {@link Queue} as an Effect `Sink`: run a
 * `Stream` of message bodies into it and every element is enqueued.
 *
 * Each stream chunk becomes one `sendBatch` call. Chunks larger than a
 * Cloudflare batch (100 messages / 256 KB) are split into consecutive
 * batches, preserving order. Bodies are any JSON-serializable value, the
 * same as {@link WriteQueueClient.send}.
 *
 * Provide {@link QueueSinkBinding} (native Worker binding),
 * {@link QueueSinkHttp} (scoped HTTP token) or {@link QueueSinkLocal}
 * (current credentials, for Actions). Each one is the sink layered over
 * the matching `WriteQueue` implementation and wires the queue into the
 * host exactly as that layer does.
 * ### Draining a Stream into a Queue
 * **Example:** Run a Stream into a Queue
 * ```typescript
 * export default Cloudflare.Worker(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const sink = yield* Cloudflare.Queues.QueueSink(Clicks);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* Stream.fromIterable(events).pipe(Stream.run(sink));
 *         return HttpServerResponse.empty({ status: 202 });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Queues.QueueSinkBinding)),
 * );
 * ```
 *
 * **Example:** Controlling batch size
 * ```typescript
 * // one sendBatch call per 25 messages
 * yield* Stream.fromIterable(events).pipe(
 *   Stream.rechunk(25),
 *   Stream.run(sink),
 * );
 * ```
 *
 * ### Source → Transform → Sink
 * **Example:** Forward a consumed Queue into another Queue
 * ```typescript
 * Effect.gen(function* () {
 *   const enriched = yield* Cloudflare.Queues.QueueSink(EnrichedClicks);
 *
 *   yield* Cloudflare.Queues.consumeQueueMessages<Click>(Clicks, (messages) =>
 *     messages.pipe(
 *       Stream.map((message) => message.body),
 *       Stream.filter((click) => click.button === "buy"),
 *       Stream.map((click) => ({ ...click, receivedAt: Date.now() })),
 *       Stream.run(enriched),
 *     ),
 *   );
 * }).pipe(
 *   Effect.provide(
 *     Layer.mergeAll(
 *       Cloudflare.Queues.EventSourceLive,
 *       Cloudflare.Queues.QueueSinkBinding,
 *     ),
 *   ),
 * );
 * ```
 *
 * @binding
 * @product Queues
 * @category Storage & Databases
 */
export interface QueueSink extends Binding.Service<
  QueueSink,
  "Cloudflare.Queues.QueueSink",
  (queue: Queue) => Effect.Effect<QueueSinkClient>
> {}

export const QueueSink = Binding.Service<QueueSink>("Cloudflare.Queues.QueueSink");

/**
 * A `Sink` that enqueues every element it receives as one message body.
 * Runtime-only: it can only run inside the deployed Worker (or Action).
 */
export type QueueSinkClient = Sink.Sink<void, unknown, never, SendError, RuntimeContext>;

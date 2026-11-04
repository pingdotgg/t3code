import * as Layer from "effect/Layer";
import { QueueSinkFromWriteQueue } from "./QueueSinkBatch.ts";
import { WriteQueueBinding } from "./WriteQueueBinding.ts";

/**
 * Implementation of the {@link QueueSink} service over the native Worker
 * queue binding ({@link WriteQueueBinding}). Registers the same `queue`
 * binding as `WriteQueue`, so a Worker can use both on one queue.
 *
 * Works under `alchemy dev`: a local Worker's binding targets the local
 * queue broker.
 * ### Providing the Layer
 * **Example:** Drain a Stream from a Worker
 * ```typescript
 * export default Cloudflare.Worker(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const sink = yield* Cloudflare.Queues.QueueSink(Clicks);
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
 * @layer
 * @provides Cloudflare.Queues.QueueSink
 * @product Queues
 * @category Storage & Databases
 */
export const QueueSinkBinding = QueueSinkFromWriteQueue.pipe(Layer.provide(WriteQueueBinding));

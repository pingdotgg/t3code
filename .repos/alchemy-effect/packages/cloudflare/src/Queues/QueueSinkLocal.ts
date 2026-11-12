import * as Layer from "effect/Layer";
import { QueueSinkFromWriteQueue } from "./QueueSinkBatch.ts";
import { WriteQueueLocal } from "./WriteQueueLocal.ts";

/**
 * Implementation of the {@link QueueSink} service that pushes over the
 * Queues bulk-push HTTP API with the **current credentials**
 * ({@link WriteQueueLocal}) — for draining a Stream into a queue from an
 * Action or other deploy-time Effect, with no Worker host.
 * ### Providing the Layer
 * **Example:** Seed a queue from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const sink = yield* Cloudflare.Queues.QueueSink(queue);
 *     return Effect.fn(function* () {
 *       yield* Stream.range(1, 500).pipe(
 *         Stream.map((id) => ({ event: "seed", id })),
 *         Stream.run(sink),
 *       );
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Queues.QueueSinkLocal)),
 * );
 * ```
 *
 * @layer
 * @provides Cloudflare.Queues.QueueSink
 * @product Queues
 * @category Storage & Databases
 */
export const QueueSinkLocal = QueueSinkFromWriteQueue.pipe(Layer.provide(WriteQueueLocal));

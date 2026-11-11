import * as Layer from "effect/Layer";
import { QueueSinkFromWriteQueue } from "./QueueSinkBatch.ts";
import { WriteQueueHttp } from "./WriteQueueHttp.ts";

/**
 * Implementation of the {@link QueueSink} service over the Queues bulk-push
 * HTTP API ({@link WriteQueueHttp}), authenticated with a scoped
 * `Queues Write` API token bound into the host.
 * ### Providing the Layer
 * **Example:** Drain a Stream over HTTP
 * ```typescript
 * Effect.gen(function* () {
 *   const sink = yield* Cloudflare.Queues.QueueSink(Clicks);
 *   // ...
 * }).pipe(Effect.provide(Cloudflare.Queues.QueueSinkHttp));
 * ```
 *
 * @layer
 * @provides Cloudflare.Queues.QueueSink
 * @product Queues
 * @category Storage & Databases
 */
export const QueueSinkHttp = QueueSinkFromWriteQueue.pipe(Layer.provide(WriteQueueHttp));

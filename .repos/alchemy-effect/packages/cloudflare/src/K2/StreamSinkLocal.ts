import * as Layer from "effect/Layer";
import { StreamSinkFromWriteStream } from "./StreamSinkBatch.ts";
import { WriteStreamLocal } from "./WriteStreamLocal.ts";

/**
 * Implementation of the {@link StreamSink} service that appends over the
 * stream's HTTP input with the **current credentials**
 * ({@link WriteStreamLocal}) — for draining a Stream into K2 from an Action
 * or other deploy-time Effect. The stream needs `http: true`.
 * ### Providing the Layer
 * **Example:** Seed a stream from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const sink = yield* Cloudflare.K2.StreamSink(Orders);
 *     return Effect.fn(function* () {
 *       yield* Stream.range(1, 500).pipe(
 *         Stream.map((id) => ({ content: JSON.stringify({ id }) })),
 *         Stream.run(sink),
 *       );
 *     });
 *   }).pipe(Effect.provide(Cloudflare.K2.StreamSinkLocal)),
 * );
 * ```
 *
 * @layer
 * @provides Cloudflare.K2.StreamSink
 * @product K2
 * @category Storage & Databases
 */
export const StreamSinkLocal = StreamSinkFromWriteStream.pipe(Layer.provide(WriteStreamLocal));

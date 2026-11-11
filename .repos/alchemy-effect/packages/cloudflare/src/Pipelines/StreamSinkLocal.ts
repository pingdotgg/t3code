import * as Layer from "effect/Layer";
import { StreamSinkFromWriteStream } from "./StreamSinkBatch.ts";
import { WriteStreamLocal } from "./WriteStreamLocal.ts";

/**
 * Implementation of the {@link StreamSink} service over the stream's HTTP ingest endpoint with the **current credentials** ({@link WriteStreamLocal}) — for draining an Effect Stream into a Pipelines stream from an Action, with no Worker host. The stream needs `http` enabled.
 * ### Providing the Layer
 * **Example:** Provide the sink layer
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const sink = yield* Cloudflare.Basin.StreamSink(PageViews);
 *     return Effect.fn(function* () {
 *       yield* EffectStream.fromIterable(views).pipe(EffectStream.run(sink));
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Basin.StreamSinkLocal)),
 * );
 * ```
 *
 * @layer
 * @provides Cloudflare.Pipelines.StreamSink
 * @product Pipelines
 * @category Storage & Databases
 */
export const StreamSinkLocal = StreamSinkFromWriteStream.pipe(Layer.provide(WriteStreamLocal));

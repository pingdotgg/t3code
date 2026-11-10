import * as Layer from "effect/Layer";
import { StreamSinkFromWriteStream } from "./StreamSinkBatch.ts";
import { WriteStreamBinding } from "./WriteStreamBinding.ts";

/**
 * Implementation of the {@link StreamSink} service over the native Worker `pipelines` binding ({@link WriteStreamBinding}). Registers the same binding as `WriteStream`, so a Worker can use both on one stream.
 * ### Providing the Layer
 * **Example:** Provide the sink layer
 * ```typescript
 * Effect.gen(function* () {
 *   const sink = yield* Cloudflare.Basin.StreamSink(PageViews);
 *   // ...
 * }).pipe(Effect.provide(Cloudflare.Basin.StreamSinkBinding));
 * ```
 *
 * @layer
 * @provides Cloudflare.Pipelines.StreamSink
 * @product Pipelines
 * @category Storage & Databases
 */
export const StreamSinkBinding = StreamSinkFromWriteStream.pipe(Layer.provide(WriteStreamBinding));

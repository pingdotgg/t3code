import * as Layer from "effect/Layer";
import { StreamSinkFromWriteStream } from "./StreamSinkBatch.ts";
import { WriteStreamHttp } from "./WriteStreamHttp.ts";

/**
 * Implementation of the {@link StreamSink} service over the stream's HTTP ingest endpoint ({@link WriteStreamHttp}), authenticated with a scoped `Pipelines Send` API token bound into the host. The stream needs `http` enabled.
 * ### Providing the Layer
 * **Example:** Provide the sink layer
 * ```typescript
 * Effect.gen(function* () {
 *   const sink = yield* Cloudflare.Basin.StreamSink(PageViews);
 *   // ...
 * }).pipe(Effect.provide(Cloudflare.Basin.StreamSinkHttp));
 * ```
 *
 * @layer
 * @provides Cloudflare.Pipelines.StreamSink
 * @product Pipelines
 * @category Storage & Databases
 */
export const StreamSinkHttp = StreamSinkFromWriteStream.pipe(Layer.provide(WriteStreamHttp));

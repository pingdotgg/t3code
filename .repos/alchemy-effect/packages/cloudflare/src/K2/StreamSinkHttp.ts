import * as Layer from "effect/Layer";
import { StreamSinkFromWriteStream } from "./StreamSinkBatch.ts";
import { WriteStreamHttp } from "./WriteStreamHttp.ts";

/**
 * Implementation of the {@link StreamSink} service over the stream's HTTP
 * input ({@link WriteStreamHttp}), authenticated with a scoped `K2 Produce`
 * API token bound into the host. The stream needs `http: true`.
 * ### Providing the Layer
 * **Example:** Drain a Stream over HTTP
 * ```typescript
 * Effect.gen(function* () {
 *   const sink = yield* Cloudflare.K2.StreamSink(Orders);
 *   // ...
 * }).pipe(Effect.provide(Cloudflare.K2.StreamSinkHttp));
 * ```
 *
 * @layer
 * @provides Cloudflare.K2.StreamSink
 * @product K2
 * @category Storage & Databases
 */
export const StreamSinkHttp = StreamSinkFromWriteStream.pipe(Layer.provide(WriteStreamHttp));

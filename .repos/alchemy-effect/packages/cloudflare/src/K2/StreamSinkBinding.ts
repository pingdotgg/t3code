import * as Layer from "effect/Layer";
import { StreamSinkFromWriteStream } from "./StreamSinkBatch.ts";
import { WriteStreamBinding } from "./WriteStreamBinding.ts";

/**
 * Implementation of the {@link StreamSink} service over the native Worker
 * `k2` binding ({@link WriteStreamBinding}). Registers the same binding as
 * `WriteStream`, so a Worker can use both on one stream.
 * ### Providing the Layer
 * **Example:** Drain a Stream from a Worker
 * ```typescript
 * export default Cloudflare.Worker(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const sink = yield* Cloudflare.K2.StreamSink(Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* Stream.make({ content: "a" }, { content: "b" }).pipe(Stream.run(sink));
 *         return HttpServerResponse.empty({ status: 202 });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.K2.StreamSinkBinding)),
 * );
 * ```
 *
 * @layer
 * @provides Cloudflare.K2.StreamSink
 * @product K2
 * @category Storage & Databases
 */
export const StreamSinkBinding = StreamSinkFromWriteStream.pipe(Layer.provide(WriteStreamBinding));

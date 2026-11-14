import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeHttpStreamBinding } from "./StreamHttp.ts";
import { WriteStream } from "./WriteStream.ts";

/**
 * HTTP-backed implementation of the {@link WriteStream} service. Creates
 * a scoped `AccountApiToken` with the `Pipelines Send` permission, binds
 * it into the host, and POSTs records to the stream's HTTP ingest
 * endpoint (`https://{stream_id}.ingest.cloudflare.com`).
 *
 * The stream must have its HTTP endpoint enabled — declare it with
 * `http: true` (authenticated). Records are validated and encoded with
 * the stream's Effect Schema exactly as with `WriteStreamBinding`.
 * ### Providing the Layer
 * **Example:** Send over HTTP from any host
 * ```typescript
 * const Events = Cloudflare.Basin.Stream("Events", { http: true });
 *
 * Effect.gen(function* () {
 *   const events = yield* Cloudflare.Basin.WriteStream(Events);
 *   // ...
 * }).pipe(Effect.provide(Cloudflare.Basin.WriteStreamHttp));
 * ```
 *
 * @layer
 * @provides Cloudflare.Pipelines.WriteStream
 * @product Pipelines
 * @category Storage & Databases
 */
export const WriteStreamHttp = Layer.effect(
  WriteStream,
  Effect.suspend(() =>
    makeHttpStreamBinding({ layer: "WriteStreamHttp", makeClient: (client) => client }),
  ),
);

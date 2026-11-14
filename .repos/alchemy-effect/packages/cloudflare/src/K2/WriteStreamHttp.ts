import * as k2 from "@distilled.cloud/cloudflare/k2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toProduceRecords } from "./K2Codec.ts";
import { type K2Auth, makeK2HttpAuth } from "./K2Http.ts";
import type { EncodedRecord, RecordSchema } from "./K2Types.ts";
import type { Stream } from "./Stream.ts";
import { WriteStream } from "./WriteStream.ts";
import { makeWriteStreamClient } from "./WriteStreamClient.ts";

/**
 * HTTP-backed implementation of the {@link WriteStream} service. Mints a
 * scoped `K2 Produce` {@link AccountApiToken}, binds it into the host, and
 * appends records through the stream's HTTP input
 * (`POST https://<id>.k2.cloudflarestorage.com/produce`).
 *
 * The stream must have its HTTP input enabled (`http: true`). Works on any
 * host — Workers, containers, Lambda.
 * ### Providing the Layer
 * **Example:** Produce over HTTP
 * ```typescript
 * const Orders = Cloudflare.K2.Stream("Orders", { http: true });
 *
 * Effect.gen(function* () {
 *   const orders = yield* Cloudflare.K2.WriteStream(Orders);
 *   // ...
 * }).pipe(Effect.provide(Cloudflare.K2.WriteStreamHttp));
 * ```
 *
 * @layer
 * @provides Cloudflare.K2.WriteStream
 * @product K2
 * @category Storage & Databases
 */
export const WriteStreamHttp = Layer.effect(
  WriteStream,
  Effect.gen(function* () {
    const auth = yield* makeK2HttpAuth;
    return Effect.fn(function* (stream: Stream<any>) {
      const streamAuth = yield* auth(stream, "K2 Produce");
      return makeWriteStreamHttpClient(streamAuth, yield* stream.streamId, stream.RecordSchema);
    });
  }),
);

/**
 * Build the producer client over the K2 `produce` HTTP API. Shared by
 * {@link WriteStreamHttp} and `WriteStreamLocal`.
 */
export const makeWriteStreamHttpClient = (
  auth: K2Auth,
  streamId: Effect.Effect<string>,
  schema: RecordSchema<any> | undefined,
) =>
  makeWriteStreamClient(schema, (records: ReadonlyArray<EncodedRecord>) =>
    streamId.pipe(
      Effect.flatMap((id) =>
        auth.authorize(k2.produce({ streamId: id, records: toProduceRecords(records) })),
      ),
      Effect.asVoid,
    ),
  );

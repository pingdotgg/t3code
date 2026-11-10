import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeK2LocalAuth } from "./K2Http.ts";
import type { Stream } from "./Stream.ts";
import { WriteStream } from "./WriteStream.ts";
import { makeWriteStreamHttpClient } from "./WriteStreamHttp.ts";

/**
 * Local implementation of the {@link WriteStream} service — appends records
 * through the stream's HTTP input with the **current credentials** instead
 * of a native binding or a scoped token. Provide it on an Action (or any
 * deploy-time Effect) to seed a stream with the same client a Worker uses.
 *
 * The stream must have its HTTP input enabled (`http: true`). The stream id
 * is resolved at apply time, so the stream can be created in the same
 * deploy.
 * ### Providing the Layer
 * **Example:** Seed a stream from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const orders = yield* Cloudflare.K2.WriteStream(Orders);
 *     return Effect.fn(function* () {
 *       yield* orders.send([{ content: "hello" }]);
 *     });
 *   }).pipe(Effect.provide(Cloudflare.K2.WriteStreamLocal)),
 * );
 * ```
 *
 * @layer
 * @provides Cloudflare.K2.WriteStream
 * @product K2
 * @category Storage & Databases
 */
export const WriteStreamLocal = Layer.effect(
  WriteStream,
  Effect.gen(function* () {
    const auth = yield* makeK2LocalAuth;
    return Effect.fn(function* (stream: Stream<any>) {
      // Deferred accessor — resolves the id at apply time. No `host.bind`:
      // the local variant registers no binding.
      return makeWriteStreamHttpClient(auth, yield* stream.streamId, stream.RecordSchema);
    });
  }),
);

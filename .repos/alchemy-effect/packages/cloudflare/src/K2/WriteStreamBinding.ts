import { UnknownCloudflareError } from "@distilled.cloud/cloudflare/Errors";
import * as k2 from "@distilled.cloud/cloudflare/k2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { EncodedRecord, ProduceError } from "./K2Types.ts";
import type { Stream } from "./Stream.ts";
import { WriteStream } from "./WriteStream.ts";
import { makeWriteStreamClient } from "./WriteStreamClient.ts";

/**
 * The runtime shape of a `k2` Worker binding — `env.ORDERS` for a
 * `K2.Stream` in a Worker's `env`. `@cloudflare/workers-types` does not
 * declare it yet. `send` resolves (does not throw) on API errors; a
 * rejected promise means the append outcome is unknown.
 */
export interface K2StreamBinding {
  send(
    records: Array<{ content: ArrayBuffer | Uint8Array; headers?: { [key: string]: string } }>,
  ): Promise<
    | { success: true }
    | { success: false; error: { code: number; message: string; retryable: boolean } }
  >;
}

/**
 * Implementation of the {@link WriteStream} service over the native Worker
 * `k2` binding. The stream must have its Worker-binding input enabled (the
 * default).
 *
 * K2 has no local simulation, so a Worker using this layer cannot run under
 * `alchemy dev`.
 * ### Providing the Layer
 * **Example:** Produce from a Worker
 * ```typescript
 * export default Cloudflare.Worker(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const orders = yield* Cloudflare.K2.WriteStream(Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* orders.send([{ content: "hello" }]);
 *         return HttpServerResponse.empty({ status: 202 });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.K2.WriteStreamBinding)),
 * );
 * ```
 *
 * @layer
 * @provides Cloudflare.K2.WriteStream
 * @product K2
 * @category Storage & Databases
 */
export const WriteStreamBinding = Layer.effect(
  WriteStream,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (stream: Stream<any>) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${stream}`({
          bindings: [
            {
              type: "k2",
              name: stream.LogicalId,
              stream: stream.streamId,
            },
          ],
        });
      }
      const raw = Effect.sync(() => (env as { [key: string]: K2StreamBinding })[stream.LogicalId]!);
      return makeWriteStreamClient(stream.RecordSchema, (records) =>
        raw.pipe(Effect.flatMap((binding) => sendViaBinding(binding, records))),
      );
    });
  }),
);

/**
 * Append through the native binding. API failures resolve (they do not
 * throw), so map their code onto the same typed tags the HTTP path produces.
 * A rejected promise means the append outcome is unknown.
 */
export const sendViaBinding = (
  binding: K2StreamBinding,
  records: ReadonlyArray<EncodedRecord>,
): Effect.Effect<void, ProduceError> =>
  Effect.tryPromise({
    try: () =>
      binding.send(
        records.map((record) => ({
          content: record.content,
          ...(record.headers ? { headers: record.headers } : {}),
        })),
      ),
    catch: (cause) =>
      k2.K2AppendOutcomeUnknown.make({
        code: 10212,
        message: `K2 binding send rejected; the batch may have been stored: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
  }).pipe(
    Effect.flatMap((result) =>
      result.success ? Effect.void : Effect.fail(toProduceError(result.error)),
    ),
  );

/** Map a binding error code onto the typed tag the HTTP API uses for it. */
export const toProduceError = (error: { code: number; message: string }): ProduceError => {
  const fields = { code: error.code, message: error.message };
  switch (error.code) {
    case 10200:
      return k2.K2StreamNotFound.make(fields);
    case 10204:
      return k2.K2InvalidRequest.make(fields);
    case 10206:
      return k2.K2RequestTooLarge.make(fields);
    case 10207:
      return k2.K2RecordTooLarge.make(fields);
    case 10211:
      return k2.K2Unavailable.make(fields);
    case 10212:
      return k2.K2AppendOutcomeUnknown.make(fields);
    default:
      return UnknownCloudflareError.make(fields);
  }
};

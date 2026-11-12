import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { EncodedRecord, K2SchemaError, ProduceError } from "./K2Types.ts";
import type { Stream, StreamRecord } from "./Stream.ts";

/**
 * Binding service that turns a K2 {@link Stream} into a typed
 * {@link WriteStreamClient} you can call from a Worker's (or any host's)
 * runtime Effect.
 *
 * `send` appends a batch of records atomically: all of them are stored, or
 * none. A batch can be at most 5 MB and each record at most 1 MB.
 * ### Sending Records
 * **Example:** Producer route
 * ```typescript
 * const orders = yield* Cloudflare.K2.WriteStream(Orders);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     yield* orders.send([
 *       { content: JSON.stringify({ id: 1 }), headers: { source: "api" } },
 *       { content: new Uint8Array([1, 2, 3]) },
 *     ]);
 *     return HttpServerResponse.empty({ status: 202 });
 *   }),
 * };
 * ```
 *
 * ### Typed Records
 * **Example:** Send values of the stream's schema
 * ```typescript
 * const Order = Schema.Struct({ id: Schema.Number, total: Schema.Number });
 * const Orders = Cloudflare.K2.Stream("Orders", { schema: Order });
 *
 * const orders = yield* Cloudflare.K2.WriteStream(Orders);
 * // JSON-encoded, sent with `content-type: application/json`
 * yield* orders.send([{ id: 1, total: 42 }]);
 * ```
 *
 * ### Handling Errors
 * **Example:** Retry only when the batch was not stored
 * ```typescript
 * yield* orders.send(records).pipe(
 *   // K2Unavailable: the batch was NOT stored. Never retry
 *   // K2AppendOutcomeUnknown — the batch may have been stored.
 *   Effect.retry({
 *     while: (e) => e._tag === "K2Unavailable",
 *     times: 3,
 *   }),
 * );
 * ```
 *
 * Provide {@link WriteStreamBinding} (native `k2` Worker binding),
 * {@link WriteStreamHttp} (scoped `K2 Produce` token over the stream's HTTP
 * input) or {@link WriteStreamLocal} (current credentials, for Actions).
 *
 * @binding
 * @product K2
 * @category Storage & Databases
 */
export interface WriteStream extends Binding.Service<
  WriteStream,
  "Cloudflare.K2.WriteStream",
  (stream: Stream<any>) => Effect.Effect<WriteStreamClient<any>>
> {
  <A>(stream: Stream<A>): Effect.Effect<WriteStreamClient<StreamRecord<A>>, never, WriteStream>;
}

export const WriteStream = Binding.Service<WriteStream>("Cloudflare.K2.WriteStream");

/**
 * Producer client for a K2 stream. `A` is the stream's schema type, or raw
 * bytes plus headers (`Cloudflare.K2.Record`) for a stream without one.
 */
export interface WriteStreamClient<A> {
  /** Append a batch of records atomically. */
  send(records: ReadonlyArray<A>): Effect.Effect<void, ProduceError, RuntimeContext>;
  /** Encode values into the bytes + headers shape `sendEncoded` accepts. */
  encode(records: ReadonlyArray<A>): Effect.Effect<ReadonlyArray<EncodedRecord>, K2SchemaError>;
  /** Append already-encoded records atomically. */
  sendEncoded(
    records: ReadonlyArray<EncodedRecord>,
  ): Effect.Effect<void, ProduceError, RuntimeContext>;
}

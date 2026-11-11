import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import type { ProduceError } from "./K2Types.ts";
import type { Stream, StreamRecord } from "./Stream.ts";

/**
 * Binding service that exposes a K2 {@link Stream} as an Effect `Sink`: run
 * a `Stream` of records into it and every element is appended.
 *
 * Each upstream chunk is packed, in order, into `send` calls of at most
 * 5 MB; a record over the 1 MB limit ships alone so K2's rejection
 * surfaces. A batch that failed with `K2Unavailable` (not stored) is
 * retried a bounded number of times; `K2AppendOutcomeUnknown` is never
 * retried because the batch may have been stored.
 *
 * Provide {@link StreamSinkBinding} (native Worker binding),
 * {@link StreamSinkHttp} (scoped `K2 Produce` token) or
 * {@link StreamSinkLocal} (current credentials, for Actions).
 * ### Draining a Stream into K2
 * **Example:** Run a Stream into a K2 stream
 * ```typescript
 * export default Cloudflare.Worker(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const sink = yield* Cloudflare.K2.StreamSink(Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* Stream.fromIterable(events).pipe(
 *           Stream.map((event) => ({ content: JSON.stringify(event) })),
 *           Stream.run(sink),
 *         );
 *         return HttpServerResponse.empty({ status: 202 });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.K2.StreamSinkBinding)),
 * );
 * ```
 *
 * **Example:** Typed sink with a Schema
 * ```typescript
 * const sink = yield* Cloudflare.K2.StreamSink(Orders, { schema: Order });
 * yield* Stream.fromIterable(orders).pipe(Stream.run(sink));
 * ```
 *
 * @binding
 * @product K2
 * @category Storage & Databases
 */
export interface StreamSink extends Binding.Service<
  StreamSink,
  "Cloudflare.K2.StreamSink",
  (stream: Stream<any>) => Effect.Effect<StreamSinkClient<any>>
> {
  <A>(stream: Stream<A>): Effect.Effect<StreamSinkClient<StreamRecord<A>>, never, StreamSink>;
}

export const StreamSink = Binding.Service<StreamSink>("Cloudflare.K2.StreamSink");

/**
 * A `Sink` that appends every element it receives as one K2 record.
 * Runtime-only: it can only run inside the deployed host (or an Action).
 */
export type StreamSinkClient<A> = Sink.Sink<void, A, never, ProduceError, RuntimeContext>;

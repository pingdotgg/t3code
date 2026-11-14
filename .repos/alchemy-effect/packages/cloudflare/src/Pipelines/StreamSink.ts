import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type { PipelineRecord } from "cloudflare:pipelines";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import type { Stream, StreamRecord } from "./Stream.ts";
import type { StreamSendError } from "./WriteStream.ts";

/**
 * Binding service that exposes a Pipelines {@link Stream} as an Effect
 * `Sink`: run a `Stream` of records into it and every element is
 * ingested. Also exported as `Cloudflare.Basin.StreamSink`.
 *
 * Records are typed, validated and encoded by the stream's Effect Schema
 * (plain JSON objects when it has none). Each upstream chunk is packed
 * greedily into requests of at most 5 MB, preserving order.
 *
 * Provide `StreamSinkBinding` (native Worker binding), `StreamSinkHttp`
 * (scoped `Pipelines Send` token) or `StreamSinkLocal` (current
 * credentials, for Actions) — each is the sink layered over the matching
 * `WriteStream` implementation.
 * ### Draining a Stream into a Pipelines Stream
 * **Example:** Run an Effect Stream into a Pipelines stream
 * ```typescript
 * export default Cloudflare.Worker(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const sink = yield* Cloudflare.Basin.StreamSink(PageViews);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* EffectStream.fromIterable(views).pipe(EffectStream.run(sink));
 *         return HttpServerResponse.empty({ status: 202 });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Basin.StreamSinkBinding)),
 * );
 * ```
 *
 * **Example:** Controlling request size
 * ```typescript
 * // at most 500 records per send
 * yield* events.pipe(EffectStream.rechunk(500), EffectStream.run(sink));
 * ```
 *
 * @binding
 * @product Pipelines
 * @category Storage & Databases
 */
export interface StreamSink extends Binding.Service<
  StreamSink,
  "Cloudflare.Pipelines.StreamSink",
  (stream: Stream<any>) => Effect.Effect<StreamSinkClient<any>>
> {
  <A, E = never, Req = never>(
    stream: Stream<A> | Effect.Effect<Stream<A>, E, Req>,
  ): Effect.Effect<StreamSinkClient<StreamRecord<A>>, E, StreamSink | Req>;
}

export const StreamSink = Binding.Service<StreamSink>("Cloudflare.Pipelines.StreamSink");

/**
 * A `Sink` that ingests every element it receives as one record.
 * Runtime-only: it can only run inside the deployed Worker (or Action).
 */
export type StreamSinkClient<A = PipelineRecord> = Sink.Sink<
  void,
  A,
  never,
  StreamSendError,
  RuntimeContext
>;

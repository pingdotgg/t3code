import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type { Pipeline, PipelineRecord } from "cloudflare:pipelines";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { LegacyPipeline } from "./LegacyPipeline.ts";
import type { Stream, StreamRecord } from "./Stream.ts";

/**
 * Binding service that turns a Pipelines {@link Stream} (or a
 * {@link LegacyPipeline}) into a {@link WriteStreamClient} you can call
 * from a Worker's (or Action's) runtime Effect. Also exported as
 * `Cloudflare.Basin.WriteStream`.
 *
 * Producer-only — `send` ingests a batch of records into the stream. When
 * the stream was declared with an Effect Schema, the client is typed by
 * it (`send(records: PageView[])`) and every record is validated and
 * encoded with `Schema.toCodecJson` before it is sent — Cloudflare
 * accepts schema-violating records and silently drops them later, so
 * this is the only validation. Without a schema, `send` takes plain JSON
 * objects.
 *
 * Provide one implementation layer:
 * - {@link WriteStreamBinding} — native Worker `pipelines` binding
 * - `WriteStreamHttp` — the stream's HTTP ingest endpoint with a scoped
 *   `Pipelines Send` API token (the stream needs `http` enabled)
 * - `WriteStreamLocal` — the HTTP ingest endpoint with the current
 *   credentials, for Actions and other deploy-time Effects
 * ### Sending Events
 * **Example:** Typed producer route
 * ```typescript
 * class PageView extends Schema.Class<PageView>("PageView")({
 *   url: Schema.String,
 *   at: Schema.Date,
 * }) {}
 *
 * export const PageViews = Cloudflare.Basin.Stream("PageViews", {
 *   schema: PageView,
 * });
 *
 * export default Cloudflare.Worker(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const views = yield* Cloudflare.Basin.WriteStream(PageViews);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* views.send([new PageView({ url: "/", at: new Date() })]);
 *         return HttpServerResponse.empty({ status: 202 });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Basin.WriteStreamBinding)),
 * );
 * ```
 *
 * **Example:** Untyped stream
 * ```typescript
 * const events = yield* Cloudflare.Basin.WriteStream(Events);
 * yield* events.send([{ event: "click", at: new Date().toISOString() }]);
 * ```
 *
 * ### Handling Errors
 * **Example:** Recover from a failed send
 * ```typescript
 * yield* views.send(batch).pipe(
 *   Effect.catchTag("StreamSendError", (e) =>
 *     Effect.logWarning(`dropped ${batch.length} events: ${e.message}`),
 *   ),
 * );
 * ```
 *
 * @binding
 * @product Pipelines
 * @category Storage & Databases
 */
export interface WriteStream extends Binding.Service<
  WriteStream,
  "Cloudflare.Pipelines.WriteStream",
  (stream: Stream<any> | LegacyPipeline) => Effect.Effect<WriteStreamClient<any>>
> {
  <A, E = never, Req = never>(
    stream: Stream<A> | Effect.Effect<Stream<A>, E, Req>,
  ): Effect.Effect<WriteStreamClient<StreamRecord<A>>, E, WriteStream | Req>;
  <E = never, Req = never>(
    stream: LegacyPipeline | Effect.Effect<LegacyPipeline, E, Req>,
  ): Effect.Effect<WriteStreamClient<PipelineRecord>, E, WriteStream | Req>;
}

export const WriteStream = Binding.Service<WriteStream>("Cloudflare.Pipelines.WriteStream");

/**
 * Producer client for a Pipelines stream. `A` is the stream's record type
 * (its Effect Schema's `Type`, or a plain JSON object).
 */
export interface WriteStreamClient<A = PipelineRecord> {
  /**
   * The native Worker `pipelines` binding. Only available from
   * `WriteStreamBinding`; the HTTP/local clients die.
   */
  raw: Effect.Effect<Pipeline, never, RuntimeContext>;
  /** Validate, encode and ingest a batch of records. */
  send(records: ReadonlyArray<A>): Effect.Effect<void, StreamSendError, RuntimeContext>;
  /**
   * Validate and encode records into the JSON objects sent on the wire
   * (`Schema.toCodecJson` of the stream's schema; identity when untyped).
   */
  encode(records: ReadonlyArray<A>): Effect.Effect<ReadonlyArray<PipelineRecord>, StreamSendError>;
  /** Ingest already-encoded records. */
  sendEncoded(
    records: ReadonlyArray<PipelineRecord>,
  ): Effect.Effect<void, StreamSendError, RuntimeContext>;
}

/**
 * Raised when records could not be ingested: a record failed the stream's
 * Effect Schema (`reason: "InvalidRecord"`), or the send itself failed
 * (`reason: "SendFailed"`).
 */
export class StreamSendError extends Data.TaggedError("StreamSendError")<{
  message: string;
  cause?: unknown;
  /** Why the send failed. Absent on errors raised by older clients. */
  reason?: "InvalidRecord" | "SendFailed";
  /** Index of the offending record within the batch, for `InvalidRecord`. */
  index?: number;
}> {}

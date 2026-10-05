import type { Pipeline, PipelineRecord } from "cloudflare:pipelines";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { LegacyPipeline } from "./LegacyPipeline.ts";
import type { Stream } from "./Stream.ts";

/**
 * Binding service that turns a Pipelines {@link Stream} (or a
 * {@link LegacyPipeline}) into a typed {@link WriteStreamClient} you can
 * call from a Worker's runtime Effect.
 *
 * The Cloudflare Worker `pipelines` binding is producer-only — `send`
 * ingests a batch of JSON records into the stream.
 * ### Sending Events
 * **Example:** Producer route
 * ```typescript
 * const events = yield* Cloudflare.Pipelines.WriteStream(Stream);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     yield* events.send([{ event: "click", at: new Date().toISOString() }]);
 *     return HttpServerResponse.empty({ status: 202 });
 *   }),
 * };
 * ```
 *
 * Provide {@link WriteStreamBinding} (native Worker binding) in the
 * worker's runtime layer to resolve the underlying stream at request time.
 *
 * `WriteStream` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.Pipelines.WriteStream(stream)`.
 *
 * @binding
 * @product Pipelines
 * @category Storage & Databases
 */
export interface WriteStream extends Binding.Service<
  WriteStream,
  "Cloudflare.Pipelines.WriteStream",
  (stream: Stream | LegacyPipeline) => Effect.Effect<WriteStreamClient>
> {}

export const WriteStream = Binding.Service<WriteStream>(
  "Cloudflare.Pipelines.WriteStream",
);

export interface WriteStreamClient {
  raw: Effect.Effect<Pipeline, never, RuntimeContext>;
  send(
    records: ReadonlyArray<PipelineRecord>,
  ): Effect.Effect<void, StreamSendError, RuntimeContext>;
}

export class StreamSendError extends Data.TaggedError("StreamSendError")<{
  message: string;
  cause?: unknown;
}> {}

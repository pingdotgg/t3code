import type { RuntimeContext } from "alchemy/RuntimeContext";
import { makeBatchedSink } from "alchemy/Util/BatchedSink";
import type { PipelineRecord } from "cloudflare:pipelines";
import type { NonEmptyReadonlyArray } from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import type { Stream } from "./Stream.ts";
import { recordSize } from "./StreamCodec.ts";
import { StreamSink, type StreamSinkClient } from "./StreamSink.ts";
import { StreamSendError, WriteStream, type WriteStreamClient } from "./WriteStream.ts";

/**
 * Batch packing for {@link StreamSink}. Internal — not exported from the
 * Pipelines barrel.
 */

/** Pipelines' limit on one ingest request (5 MB), minus the array brackets. */
export const MAX_REQUEST_BYTES = 5_000_000 - 2;

/**
 * Build the sink over a `WriteStream` client: each chunk is encoded, then
 * packed into `<= MAX_REQUEST_BYTES` requests (order preserved) and sent
 * one `sendEncoded` per request.
 */
export const makeStreamSink = <A>(client: WriteStreamClient<A>): StreamSinkClient<A> =>
  Sink.unwrap(
    Effect.gen(function* () {
      // BatchedSink sends without requirements; close over the runtime
      // context the sink runs in.
      const context = yield* Effect.context<RuntimeContext>();
      return makeBatchedSink<PipelineRecord, void, StreamSendError>({
        maxRecords: Number.MAX_SAFE_INTEGER,
        maxBytes: MAX_REQUEST_BYTES,
        sizeOf: recordSize,
        send: (batch) => client.sendEncoded(batch).pipe(Effect.provideContext(context)),
      }).pipe(
        Sink.mapInputArrayEffect((chunk: NonEmptyReadonlyArray<A>) =>
          client
            .encode(chunk)
            .pipe(Effect.map((encoded) => encoded as NonEmptyReadonlyArray<PipelineRecord>)),
        ),
        // No `unprocessed` extractor is configured, so retry exhaustion
        // cannot occur; normalize the type anyway.
        Sink.mapError((error) =>
          error._tag === "BatchRetryExhaustedError"
            ? new StreamSendError({
                message: `${error.entries.length} records were not ingested`,
                cause: error,
                reason: "SendFailed",
              })
            : error,
        ),
      );
    }),
  );

/**
 * {@link StreamSink} over whichever {@link WriteStream} implementation is
 * provided. Composed with each `WriteStream` layer in
 * `StreamSinkBinding`, `StreamSinkHttp` and `StreamSinkLocal`.
 */
export const StreamSinkFromWriteStream = Layer.effect(
  StreamSink,
  Effect.gen(function* () {
    const writeStream = yield* WriteStream;
    return Effect.fn(function* (stream: Stream<any>) {
      const client = yield* writeStream(stream);
      return makeStreamSink(client);
    });
  }),
);

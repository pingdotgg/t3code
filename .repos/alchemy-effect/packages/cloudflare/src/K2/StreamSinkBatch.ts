import type { NonEmptyReadonlyArray } from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Sink from "effect/Sink";
import { wireSize } from "./K2Codec.ts";
import type { EncodedRecord } from "./K2Types.ts";
import type { Stream } from "./Stream.ts";
import { StreamSink, type StreamSinkClient } from "./StreamSink.ts";
import { WriteStream, type WriteStreamClient } from "./WriteStream.ts";

/**
 * Batch packing for {@link StreamSink}. Internal — not exported from the K2
 * barrel.
 */

/** K2's limit on one produce request (1 MB = 1,000,000 bytes). */
export const MAX_REQUEST_BYTES = 5_000_000;

/**
 * Greedily pack records into requests of at most {@link MAX_REQUEST_BYTES}
 * (wire size, base64 included), preserving order. A record larger than the
 * limit ships alone so K2's rejection surfaces instead of the record being
 * dropped.
 */
export const packStreamSinkBatches = (
  records: ReadonlyArray<EncodedRecord>,
  maxBytes: number = MAX_REQUEST_BYTES,
): ReadonlyArray<ReadonlyArray<EncodedRecord>> => {
  const batches: EncodedRecord[][] = [];
  let current: EncodedRecord[] = [];
  let currentBytes = 0;
  for (const record of records) {
    const size = wireSize(record);
    if (current.length > 0 && currentBytes + size > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(record);
    currentBytes += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
};

/** Bounded retry for a batch K2 reported as not stored (`K2Unavailable`). */
const unavailableRetry = Schedule.max([Schedule.exponential("200 millis"), Schedule.recurs(5)]);

/** Build the sink over a `WriteStream` client: one `sendEncoded` per packed batch. */
export const makeStreamSink = <A>(client: WriteStreamClient<A>): StreamSinkClient<A> =>
  Sink.forEachArray((chunk: NonEmptyReadonlyArray<A>) =>
    client.encode(chunk).pipe(
      Effect.flatMap((encoded) =>
        Effect.forEach(
          packStreamSinkBatches(encoded),
          (batch) =>
            client.sendEncoded(batch).pipe(
              Effect.retry({
                while: (e) => e._tag === "K2Unavailable",
                schedule: unavailableRetry,
              }),
            ),
          { discard: true },
        ),
      ),
    ),
  );

/**
 * {@link StreamSink} over whichever {@link WriteStream} implementation is
 * provided. Composed with each `WriteStream` layer in `StreamSinkBinding`,
 * `StreamSinkHttp` and `StreamSinkLocal`.
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

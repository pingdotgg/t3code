import type * as Firehose from "@distilled.cloud/aws/firehose";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import type { BatchRetryExhaustedError } from "../internal/BatchedSink.ts";
import type { DeliveryStream } from "./DeliveryStream.ts";

/**
 * The raw distilled `PutRecordBatch` entry. Callers stay in control of the
 * record payload (including any delimiters — Firehose does not add newlines
 * between records).
 */
export type DeliveryStreamSinkRecord = Firehose.Record;

export type DeliveryStreamSinkError =
  | Firehose.PutRecordBatchError
  | BatchRetryExhaustedError<DeliveryStreamSinkRecord>;

/**
 * A batching sink over Firehose `PutRecordBatch` (500 records / 4 MiB per
 * call).
 *
 * Each input element is a raw `Firehose.Record` (`{ Data: Uint8Array }`), so
 * callers stay in control of encoding and record framing.
 *
 * Even a 200 response can carry per-record failures (`FailedPutCount > 0`,
 * per-record `ErrorCode` — `ServiceUnavailableException` / internal failure).
 * All of them are transient, so the failed subset is re-submitted in input
 * order on a bounded schedule; exhausting retries fails the sink with a typed
 * `BatchRetryExhaustedError` carrying the stranded records.
 *
 * @binding
 * @section Streaming Records
 * @example Run a Stream of Records into the Delivery Stream
 * ```typescript
 * // init — bind the sink (provide AWS.Firehose.DeliveryStreamSinkHttp on the Function)
 * const sink = yield* AWS.Firehose.DeliveryStreamSink(deliveryStream);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime — stream newline-framed records into Firehose
 *     yield* Stream.fromIterable(lines).pipe(
 *       Stream.map((line) => ({
 *         Data: new TextEncoder().encode(`${line}\n`),
 *       })),
 *       Stream.run(sink),
 *     );
 *     return HttpServerResponse.json({ ok: true });
 *   }),
 * };
 * ```
 */
export interface DeliveryStreamSink extends Binding.Service<
  DeliveryStreamSink,
  "AWS.Firehose.DeliveryStreamSink",
  (
    deliveryStream: DeliveryStream,
  ) => Effect.Effect<
    Sink.Sink<
      void,
      DeliveryStreamSinkRecord,
      readonly DeliveryStreamSinkRecord[],
      DeliveryStreamSinkError
    >
  >
> {}

export const DeliveryStreamSink = Binding.Service<DeliveryStreamSink>(
  "AWS.Firehose.DeliveryStreamSink",
);

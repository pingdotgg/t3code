import type * as Firehose from "@distilled.cloud/aws/firehose";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DeliveryStream } from "./DeliveryStream.ts";

export interface PutRecordBatchRequest extends Omit<
  Firehose.PutRecordBatchInput,
  "DeliveryStreamName"
> {}

/**
 * Writes multiple data records into a Firehose delivery stream in a single
 * call, achieving higher throughput per producer than single-record puts.
 *
 * Grants `firehose:PutRecordBatch` on the bound delivery stream. Each request
 * supports up to 500 records and 4 MiB total (limits are AWS-enforced, not
 * client-enforced). Even a 200 response can carry per-record failures —
 * check `FailedPutCount` and retry the failed entries from
 * `RequestResponses`.
 * @binding
 * @section Putting Records
 * @example Put a batch of records
 * ```typescript
 * // init
 * const putRecordBatch = yield* AWS.Firehose.PutRecordBatch(deliveryStream);
 *
 * // runtime
 * const response = yield* putRecordBatch({
 *   Records: lines.map((line) => ({
 *     Data: new TextEncoder().encode(`${line}\n`),
 *   })),
 * });
 * if (response.FailedPutCount > 0) {
 *   // retry entries whose RequestResponses[i].ErrorCode is set
 * }
 * ```
 */
export interface PutRecordBatch extends Binding.Service<
  PutRecordBatch,
  "AWS.Firehose.PutRecordBatch",
  (
    deliveryStream: DeliveryStream,
  ) => Effect.Effect<
    (
      request: PutRecordBatchRequest,
    ) => Effect.Effect<
      Firehose.PutRecordBatchOutput,
      Firehose.PutRecordBatchError
    >
  >
> {}

export const PutRecordBatch = Binding.Service<PutRecordBatch>(
  "AWS.Firehose.PutRecordBatch",
);

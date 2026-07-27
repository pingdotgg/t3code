import type * as Firehose from "@distilled.cloud/aws/firehose";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DeliveryStream } from "./DeliveryStream.ts";

export interface PutRecordRequest extends Omit<
  Firehose.PutRecordInput,
  "DeliveryStreamName"
> {}

/**
 * Writes a single data record into a Firehose delivery stream.
 *
 * Grants `firehose:PutRecord` on the bound delivery stream. The data blob
 * can be up to 1,000 KiB; Firehose buffers records before delivering them to
 * the destination, so use a delimiter (e.g. `\n`) to disambiguate records.
 * @binding
 * @section Putting Records
 * @example Put a record from a handler
 * ```typescript
 * // init
 * const putRecord = yield* AWS.Firehose.PutRecord(deliveryStream);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const response = yield* putRecord({
 *       Record: { Data: new TextEncoder().encode("hello\n") },
 *     });
 *     return HttpServerResponse.json({ recordId: response.RecordId });
 *   }),
 * };
 * ```
 */
export interface PutRecord extends Binding.Service<
  PutRecord,
  "AWS.Firehose.PutRecord",
  (
    deliveryStream: DeliveryStream,
  ) => Effect.Effect<
    (
      request: PutRecordRequest,
    ) => Effect.Effect<Firehose.PutRecordOutput, Firehose.PutRecordError>
  >
> {}

export const PutRecord = Binding.Service<PutRecord>("AWS.Firehose.PutRecord");

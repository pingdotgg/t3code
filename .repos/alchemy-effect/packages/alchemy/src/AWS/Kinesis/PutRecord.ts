import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface PutRecordRequest extends Omit<
  Kinesis.PutRecordInput,
  "StreamName"
> {}

/**
 * Runtime binding for `kinesis:PutRecord`.
 *
 * Bind this operation to a `Stream` in the function's init phase to get a
 * callable that writes single records — the stream name is injected
 * automatically and `kinesis:PutRecord` is granted on the stream. Provide the
 * implementation with `Effect.provide(AWS.Kinesis.PutRecordHttp)`.
 * @binding
 * @section Writing Records
 * @example Put a Record from a Handler
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const stream = yield* AWS.Kinesis.Stream("OrdersStream");
 *     // init — bind the operation to the stream
 *     const putRecord = yield* AWS.Kinesis.PutRecord(stream);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime — write a record
 *         yield* putRecord({
 *           PartitionKey: "order-123",
 *           Data: new TextEncoder().encode(JSON.stringify({ orderId: "123" })),
 *         });
 *         return HttpServerResponse.text("sent");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(AWS.Kinesis.PutRecordHttp)),
 * );
 * ```
 */
export interface PutRecord extends Binding.Service<
  PutRecord,
  "AWS.Kinesis.PutRecord",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: PutRecordRequest,
    ) => Effect.Effect<Kinesis.PutRecordOutput, Kinesis.PutRecordError>
  >
> {}

export const PutRecord = Binding.Service<PutRecord>("AWS.Kinesis.PutRecord");

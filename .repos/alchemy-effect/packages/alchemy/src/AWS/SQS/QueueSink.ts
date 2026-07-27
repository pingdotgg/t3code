import type * as sqs from "@distilled.cloud/aws/sqs";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import type { BatchRetryExhaustedError } from "../internal/BatchedSink.ts";
import type { Queue } from "./Queue.ts";

/**
 * A raw `SendMessageBatchRequestEntry` minus the batch-correlation `Id`,
 * which the sink assigns per API call. Callers stay in control of
 * `MessageBody`, `MessageGroupId`, `MessageDeduplicationId`, attributes, etc.
 */
export interface QueueSinkEntry extends Omit<
  sqs.SendMessageBatchRequestEntry,
  "Id"
> {}

export type QueueSinkError =
  | sqs.SendMessageBatchError
  | BatchRetryExhaustedError<QueueSinkEntry>;

/**
 * A batching sink over SQS `SendMessageBatch` (10 entries / 256 KiB per
 * call). Per-entry failures with `SenderFault: false` (throttling, internal
 * errors) are retried on a bounded schedule; `SenderFault: true` failures are
 * permanent and dropped. Exhausting retries fails the sink with a typed
 * `BatchRetryExhaustedError` carrying the stranded entries.
 *
 * The binding grants the host function `sqs:SendMessage` and
 * `sqs:SendMessageBatch` on the queue. Provide the `QueueSinkHttp` layer
 * (which itself needs `SendMessageBatchHttp`) on the Function to implement
 * the binding.
 * @binding
 * @section Streaming Messages into a Queue
 * @example Run a Stream into a Queue
 * ```typescript
 * // init (provide SQS.QueueSinkHttp + SQS.SendMessageBatchHttp on the Function)
 * const sink = yield* SQS.QueueSink(queue);
 *
 * // runtime: batching, size limits, and transient-failure retry are handled
 * // by the sink — each element is a SendMessageBatchRequestEntry minus `Id`.
 * yield* Stream.fromIterable(messages).pipe(
 *   Stream.map((message) => ({ MessageBody: message })),
 *   Stream.run(sink),
 * );
 * ```
 *
 * @example Forward Event-Source Records into a Result Queue
 * ```typescript
 * const sink = yield* SQS.QueueSink(resultQueue);
 *
 * yield* SQS.consumeQueueMessages(sourceQueue, (records) =>
 *   records.pipe(
 *     Stream.map((record) => ({ MessageBody: record.body })),
 *     Stream.run(sink),
 *     Effect.orDie,
 *   ),
 * );
 * ```
 */
export interface QueueSink extends Binding.Service<
  QueueSink,
  "AWS.SQS.QueueSink",
  (
    queue: Queue,
  ) => Effect.Effect<
    Sink.Sink<void, QueueSinkEntry, readonly QueueSinkEntry[], QueueSinkError>
  >
> {}

export const QueueSink = Binding.Service<QueueSink>("AWS.SQS.QueueSink");

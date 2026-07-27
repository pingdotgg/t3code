import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface SendMessageBatchRequest extends Omit<
  sqs.SendMessageBatchRequest,
  "QueueUrl"
> {}

/**
 * Runtime binding for `sqs:SendMessageBatch`.
 *
 * Bind this operation to a {@link Queue} inside a function runtime to send up
 * to 10 messages per call with per-entry success/failure results. The binding
 * grants the host function `sqs:SendMessage` on the queue. Provide the
 * `SendMessageBatchHttp` layer on the Function to implement the binding.
 *
 * For an unbounded stream of messages with automatic batching and bounded
 * retry of transient per-entry failures, prefer {@link QueueSink}.
 * @binding
 * @section Sending Message Batches
 * @example Send a Batch of Messages
 * ```typescript
 * // init (provide SQS.SendMessageBatchHttp on the Function)
 * const sendMessageBatch = yield* SQS.SendMessageBatch(queue);
 *
 * // runtime
 * const result = yield* sendMessageBatch({
 *   Entries: messages.map((body, index) => ({
 *     Id: `${index}`,
 *     MessageBody: body,
 *   })),
 * });
 * // result.Successful / result.Failed
 * ```
 */
export interface SendMessageBatch extends Binding.Service<
  SendMessageBatch,
  "AWS.SQS.SendMessageBatch",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: SendMessageBatchRequest,
    ) => Effect.Effect<sqs.SendMessageBatchResult, sqs.SendMessageBatchError>
  >
> {}

export const SendMessageBatch = Binding.Service<SendMessageBatch>(
  "AWS.SQS.SendMessageBatch",
);

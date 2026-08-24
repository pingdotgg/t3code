import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface DeleteMessageBatchRequest extends Omit<
  sqs.DeleteMessageBatchRequest,
  "QueueUrl"
> {}

/**
 * Runtime binding for `sqs:DeleteMessageBatch`.
 *
 * Bind this operation to a {@link Queue} inside a function runtime to delete
 * up to 10 received messages per call with per-entry success/failure results.
 * The binding grants the host function `sqs:DeleteMessage` on the queue.
 * Provide the `DeleteMessageBatchHttp` layer on the Function to implement the
 * binding.
 * @binding
 * @section Deleting Message Batches
 * @example Delete a Batch of Processed Messages
 * ```typescript
 * // init (provide SQS.DeleteMessageBatchHttp on the Function)
 * const deleteMessageBatch = yield* SQS.DeleteMessageBatch(queue);
 *
 * // runtime: acknowledge messages received via ReceiveMessage
 * const result = yield* deleteMessageBatch({
 *   Entries: messages.map((message, index) => ({
 *     Id: `${index}`,
 *     ReceiptHandle: message.ReceiptHandle!,
 *   })),
 * });
 * // result.Successful / result.Failed
 * ```
 */
export interface DeleteMessageBatch extends Binding.Service<
  DeleteMessageBatch,
  "AWS.SQS.DeleteMessageBatch",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: DeleteMessageBatchRequest,
    ) => Effect.Effect<
      sqs.DeleteMessageBatchResult,
      sqs.DeleteMessageBatchError
    >
  >
> {}

export const DeleteMessageBatch = Binding.Service<DeleteMessageBatch>(
  "AWS.SQS.DeleteMessageBatch",
);

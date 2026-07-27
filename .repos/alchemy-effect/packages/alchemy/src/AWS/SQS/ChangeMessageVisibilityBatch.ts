import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface ChangeMessageVisibilityBatchRequest extends Omit<
  sqs.ChangeMessageVisibilityBatchRequest,
  "QueueUrl"
> {}

/**
 * Runtime binding for `sqs:ChangeMessageVisibilityBatch`.
 *
 * Bind this operation to a {@link Queue} inside a function runtime to change
 * the visibility timeout of up to 10 in-flight messages per call with
 * per-entry success/failure results. The binding grants the host function
 * `sqs:ChangeMessageVisibility` on the queue. Provide the
 * `ChangeMessageVisibilityBatchHttp` layer on the Function to implement the
 * binding.
 * @binding
 * @section Changing Message Visibility
 * @example Release a Batch of Messages Back to the Queue
 * ```typescript
 * // init (provide SQS.ChangeMessageVisibilityBatchHttp on the Function)
 * const changeMessageVisibilityBatch =
 *   yield* SQS.ChangeMessageVisibilityBatch(queue);
 *
 * // runtime
 * const result = yield* changeMessageVisibilityBatch({
 *   Entries: messages.map((message, index) => ({
 *     Id: `${index}`,
 *     ReceiptHandle: message.ReceiptHandle!,
 *     VisibilityTimeout: 0,
 *   })),
 * });
 * // result.Successful / result.Failed
 * ```
 */
export interface ChangeMessageVisibilityBatch extends Binding.Service<
  ChangeMessageVisibilityBatch,
  "AWS.SQS.ChangeMessageVisibilityBatch",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: ChangeMessageVisibilityBatchRequest,
    ) => Effect.Effect<
      sqs.ChangeMessageVisibilityBatchResult,
      sqs.ChangeMessageVisibilityBatchError
    >
  >
> {}

export const ChangeMessageVisibilityBatch =
  Binding.Service<ChangeMessageVisibilityBatch>(
    "AWS.SQS.ChangeMessageVisibilityBatch",
  );

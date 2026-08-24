import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface DeleteMessageRequest extends Omit<
  sqs.DeleteMessageRequest,
  "QueueUrl"
> {}

/**
 * Runtime binding for `sqs:DeleteMessage`.
 *
 * Bind this operation to a {@link Queue} inside a function runtime to delete
 * a message after it has been received and processed. The binding grants the
 * host function `sqs:DeleteMessage` on the queue. Provide the
 * `DeleteMessageHttp` layer on the Function to implement the binding.
 * @binding
 * @section Deleting Messages
 * @example Delete a Processed Message
 * ```typescript
 * // init (provide SQS.DeleteMessageHttp on the Function)
 * const deleteMessage = yield* SQS.DeleteMessage(queue);
 *
 * // runtime: acknowledge a message received via ReceiveMessage
 * const result = yield* receiveMessage({ MaxNumberOfMessages: 1 });
 * const [message] = result.Messages ?? [];
 * if (message?.ReceiptHandle) {
 *   yield* deleteMessage({ ReceiptHandle: message.ReceiptHandle });
 * }
 * ```
 */
export interface DeleteMessage extends Binding.Service<
  DeleteMessage,
  "AWS.SQS.DeleteMessage",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: DeleteMessageRequest,
    ) => Effect.Effect<sqs.DeleteMessageResponse, sqs.DeleteMessageError>
  >
> {}

export const DeleteMessage = Binding.Service<DeleteMessage>(
  "AWS.SQS.DeleteMessage",
);

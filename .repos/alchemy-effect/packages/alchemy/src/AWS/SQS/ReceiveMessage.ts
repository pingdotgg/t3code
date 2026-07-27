import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface ReceiveMessageRequest extends Omit<
  sqs.ReceiveMessageRequest,
  "QueueUrl"
> {}

/**
 * Runtime binding for `sqs:ReceiveMessage`.
 *
 * Bind this operation to a {@link Queue} inside a function runtime to poll
 * messages on demand. The binding grants the host function
 * `sqs:ReceiveMessage` on the queue. Provide the `ReceiveMessageHttp` layer
 * on the Function to implement the binding.
 *
 * For push-based consumption (Lambda event-source mapping) use
 * {@link consumeQueueMessages} instead of polling manually.
 * @binding
 * @section Receiving Messages
 * @example Poll for Messages
 * ```typescript
 * // init (provide SQS.ReceiveMessageHttp on the Function)
 * const receiveMessage = yield* SQS.ReceiveMessage(queue);
 *
 * // runtime: long-poll for up to 10 messages
 * const result = yield* receiveMessage({
 *   MaxNumberOfMessages: 10,
 *   WaitTimeSeconds: 2,
 * });
 * for (const message of result.Messages ?? []) {
 *   // message.Body, message.ReceiptHandle
 * }
 * ```
 */
export interface ReceiveMessage extends Binding.Service<
  ReceiveMessage,
  "AWS.SQS.ReceiveMessage",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: ReceiveMessageRequest,
    ) => Effect.Effect<sqs.ReceiveMessageResult, sqs.ReceiveMessageError>
  >
> {}

export const ReceiveMessage = Binding.Service<ReceiveMessage>(
  "AWS.SQS.ReceiveMessage",
);

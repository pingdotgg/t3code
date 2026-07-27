import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface ChangeMessageVisibilityRequest extends Omit<
  sqs.ChangeMessageVisibilityRequest,
  "QueueUrl"
> {}

/**
 * Runtime binding for `sqs:ChangeMessageVisibility`.
 *
 * Bind this operation to a {@link Queue} inside a function runtime to extend
 * or shrink the visibility timeout of an in-flight message — e.g. extend it
 * while a slow job is still processing, or set it to `0` to release the
 * message back to the queue immediately. The binding grants the host
 * function `sqs:ChangeMessageVisibility` on the queue. Provide the
 * `ChangeMessageVisibilityHttp` layer on the Function to implement the
 * binding.
 * @binding
 * @section Changing Message Visibility
 * @example Release a Message Back to the Queue
 * ```typescript
 * // init (provide SQS.ChangeMessageVisibilityHttp on the Function)
 * const changeMessageVisibility = yield* SQS.ChangeMessageVisibility(queue);
 *
 * // runtime: make the message immediately receivable again
 * yield* changeMessageVisibility({
 *   ReceiptHandle: message.ReceiptHandle!,
 *   VisibilityTimeout: 0,
 * });
 * ```
 *
 * @example Extend Processing Time for a Slow Job
 * ```typescript
 * yield* changeMessageVisibility({
 *   ReceiptHandle: message.ReceiptHandle!,
 *   VisibilityTimeout: 600,
 * });
 * ```
 */
export interface ChangeMessageVisibility extends Binding.Service<
  ChangeMessageVisibility,
  "AWS.SQS.ChangeMessageVisibility",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: ChangeMessageVisibilityRequest,
    ) => Effect.Effect<
      sqs.ChangeMessageVisibilityResponse,
      sqs.ChangeMessageVisibilityError
    >
  >
> {}

export const ChangeMessageVisibility = Binding.Service<ChangeMessageVisibility>(
  "AWS.SQS.ChangeMessageVisibility",
);

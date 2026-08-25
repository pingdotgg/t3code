import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface GetQueueAttributesRequest extends Omit<
  sqs.GetQueueAttributesRequest,
  "QueueUrl"
> {}

/**
 * Runtime binding for `sqs:GetQueueAttributes`.
 *
 * Bind this operation to a {@link Queue} inside a function runtime to read
 * live queue attributes — e.g. `ApproximateNumberOfMessages` for queue-depth
 * monitoring or backpressure decisions. The binding grants the host function
 * `sqs:GetQueueAttributes` on the queue. Provide the
 * `GetQueueAttributesHttp` layer on the Function to implement the binding.
 * @binding
 * @section Reading Queue Attributes
 * @example Monitor Queue Depth
 * ```typescript
 * // init (provide SQS.GetQueueAttributesHttp on the Function)
 * const getQueueAttributes = yield* SQS.GetQueueAttributes(queue);
 *
 * // runtime
 * const result = yield* getQueueAttributes({
 *   AttributeNames: ["ApproximateNumberOfMessages"],
 * });
 * const depth = Number(result.Attributes?.ApproximateNumberOfMessages ?? 0);
 * ```
 */
export interface GetQueueAttributes extends Binding.Service<
  GetQueueAttributes,
  "AWS.SQS.GetQueueAttributes",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request?: GetQueueAttributesRequest,
    ) => Effect.Effect<
      sqs.GetQueueAttributesResult,
      sqs.GetQueueAttributesError
    >
  >
> {}

export const GetQueueAttributes = Binding.Service<GetQueueAttributes>(
  "AWS.SQS.GetQueueAttributes",
);

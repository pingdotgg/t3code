import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface PublishBatchRequest extends Omit<
  sns.PublishBatchInput,
  "TopicArn"
> {}

/**
 * Runtime binding for `sns:PublishBatch`.
 *
 * Bind this operation to a {@link Topic} inside a function runtime to publish
 * up to 10 messages per call with per-entry success/failure results. The
 * binding grants the host function `sns:Publish` on the topic. Provide the
 * `PublishBatchHttp` layer on the Function to implement the binding.
 *
 * For an unbounded stream of messages with automatic batching and bounded
 * retry of transient per-entry failures, prefer {@link TopicSink}.
 * @binding
 * @section Publishing Message Batches
 * @example Publish a Batch of Messages
 * ```typescript
 * // init (provide SNS.PublishBatchHttp on the Function)
 * const publishBatch = yield* SNS.PublishBatch(topic);
 *
 * // runtime
 * const response = yield* publishBatch({
 *   PublishBatchRequestEntries: messages.map((message, index) => ({
 *     Id: `${index}`,
 *     Message: message,
 *   })),
 * });
 * // response.Successful / response.Failed
 * ```
 */
export interface PublishBatch extends Binding.Service<
  PublishBatch,
  "AWS.SNS.PublishBatch",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PublishBatchRequest,
    ) => Effect.Effect<sns.PublishBatchResponse, sns.PublishBatchError>
  >
> {}

export const PublishBatch = Binding.Service<PublishBatch>(
  "AWS.SNS.PublishBatch",
);

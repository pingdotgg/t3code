import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface GetTopicAttributesRequest extends Omit<
  sns.GetTopicAttributesInput,
  "TopicArn"
> {}

/**
 * Runtime binding for `sns:GetTopicAttributes`.
 *
 * Bind this operation to a {@link Topic} inside a function runtime to read
 * the topic's raw attribute map (policy, delivery status, KMS key, etc.).
 * The binding grants the host function `sns:GetTopicAttributes` on the
 * topic. Provide the `GetTopicAttributesHttp` layer on the Function to
 * implement the binding.
 * @binding
 * @section Reading Topic Attributes
 * @example Read a Topic's Attributes
 * ```typescript
 * // init (provide SNS.GetTopicAttributesHttp on the Function)
 * const getTopicAttributes = yield* SNS.GetTopicAttributes(topic);
 *
 * // runtime
 * const response = yield* getTopicAttributes();
 * const displayName = response.Attributes?.DisplayName;
 * ```
 */
export interface GetTopicAttributes extends Binding.Service<
  GetTopicAttributes,
  "AWS.SNS.GetTopicAttributes",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request?: GetTopicAttributesRequest,
    ) => Effect.Effect<
      sns.GetTopicAttributesResponse,
      sns.GetTopicAttributesError
    >
  >
> {}

export const GetTopicAttributes = Binding.Service<GetTopicAttributes>(
  "AWS.SNS.GetTopicAttributes",
);

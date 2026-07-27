import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface SetTopicAttributesRequest extends Omit<
  sns.SetTopicAttributesInput,
  "TopicArn"
> {}

/**
 * Runtime binding for `sns:SetTopicAttributes`.
 *
 * Bind this operation to a {@link Topic} inside a function runtime to set a
 * single topic attribute by name. The binding grants the host function
 * `sns:SetTopicAttributes` on the topic. Provide the
 * `SetTopicAttributesHttp` layer on the Function to implement the binding.
 * @binding
 * @section Updating Topic Attributes
 * @example Set a Topic's Display Name
 * ```typescript
 * // init (provide SNS.SetTopicAttributesHttp on the Function)
 * const setTopicAttributes = yield* SNS.SetTopicAttributes(topic);
 *
 * // runtime
 * yield* setTopicAttributes({
 *   AttributeName: "DisplayName",
 *   AttributeValue: "order-events",
 * });
 * ```
 */
export interface SetTopicAttributes extends Binding.Service<
  SetTopicAttributes,
  "AWS.SNS.SetTopicAttributes",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: SetTopicAttributesRequest,
    ) => Effect.Effect<
      sns.SetTopicAttributesResponse,
      sns.SetTopicAttributesError
    >
  >
> {}

export const SetTopicAttributes = Binding.Service<SetTopicAttributes>(
  "AWS.SNS.SetTopicAttributes",
);

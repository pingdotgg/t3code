import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface ListSubscriptionsByTopicRequest extends Omit<
  sns.ListSubscriptionsByTopicInput,
  "TopicArn"
> {}

/**
 * Runtime binding for `sns:ListSubscriptionsByTopic`.
 *
 * Bind this operation to a {@link Topic} inside a function runtime to page
 * through that topic's subscriptions; the `TopicArn` is injected
 * automatically. The binding grants the host function
 * `sns:ListSubscriptionsByTopic` on the topic. Provide the
 * `ListSubscriptionsByTopicHttp` layer on the Function to implement the
 * binding.
 * @binding
 * @section Listing a Topic's Subscriptions
 * @example List Subscriptions of a Topic
 * ```typescript
 * // init (provide SNS.ListSubscriptionsByTopicHttp on the Function)
 * const listSubscriptionsByTopic = yield* SNS.ListSubscriptionsByTopic(topic);
 *
 * // runtime
 * const response = yield* listSubscriptionsByTopic();
 * const endpoints = (response.Subscriptions ?? []).map((s) => s.Endpoint);
 * ```
 */
export interface ListSubscriptionsByTopic extends Binding.Service<
  ListSubscriptionsByTopic,
  "AWS.SNS.ListSubscriptionsByTopic",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request?: ListSubscriptionsByTopicRequest,
    ) => Effect.Effect<
      sns.ListSubscriptionsByTopicResponse,
      sns.ListSubscriptionsByTopicError
    >
  >
> {}
export const ListSubscriptionsByTopic =
  Binding.Service<ListSubscriptionsByTopic>("AWS.SNS.ListSubscriptionsByTopic");

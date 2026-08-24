import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface SubscribeRequest extends Omit<
  sns.SubscribeInput,
  "TopicArn"
> {}

/**
 * Runtime binding for `sns:Subscribe`.
 *
 * Bind this operation to a {@link Topic} to subscribe endpoints (email,
 * sms, https, sqs, ...) to the topic at runtime — for example subscribing a
 * user's email address from an API handler. The `TopicArn` is injected
 * automatically.
 * Provide the `SubscribeHttp` layer on the Function to implement the binding.
 * @binding
 * @section Subscribing Endpoints
 * @example Subscribe an Email Address
 * ```typescript
 * const subscribe = yield* SNS.Subscribe(topic);
 * const response = yield* subscribe({
 *   Protocol: "email",
 *   Endpoint: "user@example.com",
 * });
 * ```
 */
export interface Subscribe extends Binding.Service<
  Subscribe,
  "AWS.SNS.Subscribe",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: SubscribeRequest,
    ) => Effect.Effect<sns.SubscribeResponse, sns.SubscribeError>
  >
> {}

export const Subscribe = Binding.Service<Subscribe>("AWS.SNS.Subscribe");

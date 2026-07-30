import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface PublishRequest extends Omit<
  sns.PublishInput,
  "TopicArn" | "TargetArn" | "PhoneNumber"
> {}

/**
 * Runtime binding for `sns:Publish`.
 *
 * Bind this operation to a {@link Topic} inside a function runtime to get a
 * callable that automatically injects the `TopicArn`. The binding grants the
 * host function `sns:Publish` on the topic. Provide the `PublishHttp` layer
 * on the Function to implement the binding.
 * @binding
 * @section Publishing Messages
 * @example Publish from a Lambda Function
 * ```typescript
 * export class ApiFunction extends Lambda.Function<Lambda.Function>()(
 *   "ApiFunction",
 * ) {}
 *
 * export default ApiFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const topic = yield* SNS.Topic("Events");
 *
 *     // init: bind the operation to the topic (grants sns:Publish)
 *     const publish = yield* SNS.Publish(topic);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: TopicArn is injected automatically
 *         const response = yield* publish({
 *           Message: "order shipped",
 *           Subject: "order-update",
 *         });
 *         return yield* HttpServerResponse.json({
 *           messageId: response.MessageId,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(SNS.PublishHttp)),
 * );
 * ```
 */
export interface Publish extends Binding.Service<
  Publish,
  "AWS.SNS.Publish",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PublishRequest,
    ) => Effect.Effect<sns.PublishResponse, sns.PublishError>
  >
> {}

export const Publish = Binding.Service<Publish>("AWS.SNS.Publish");

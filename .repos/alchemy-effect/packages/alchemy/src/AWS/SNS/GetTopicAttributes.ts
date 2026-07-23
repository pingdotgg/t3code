import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";

export interface GetTopicAttributesRequest extends Omit<
  sns.GetTopicAttributesInput,
  "TopicArn"
> {}

export class GetTopicAttributes extends Binding.Service<
  GetTopicAttributes,
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
>()("AWS.SNS.GetTopicAttributes") {}

export const GetTopicAttributesLive = Layer.effect(
  GetTopicAttributes,
  Effect.gen(function* () {
    const Policy = yield* GetTopicAttributesPolicy;
    const getTopicAttributes = yield* sns.getTopicAttributes;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      yield* Policy(topic);
      return Effect.fn(function* (request?: GetTopicAttributesRequest) {
        return yield* getTopicAttributes({
          ...request,
          TopicArn: yield* TopicArn,
        });
      });
    });
  }),
);

export class GetTopicAttributesPolicy extends Binding.Policy<
  GetTopicAttributesPolicy,
  (topic: Topic) => Effect.Effect<void>
>()("AWS.SNS.GetTopicAttributes") {}

export const GetTopicAttributesPolicyLive =
  GetTopicAttributesPolicy.layer.succeed(
    Effect.fn(function* (host, topic) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.SNS.GetTopicAttributes(${topic}))`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["sns:GetTopicAttributes"],
              Resource: [topic.topicArn],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `GetTopicAttributesPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

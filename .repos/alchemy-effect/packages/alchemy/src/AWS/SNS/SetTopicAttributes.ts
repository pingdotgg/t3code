import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";

export interface SetTopicAttributesRequest extends Omit<
  sns.SetTopicAttributesInput,
  "TopicArn"
> {}

export class SetTopicAttributes extends Binding.Service<
  SetTopicAttributes,
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
>()("AWS.SNS.SetTopicAttributes") {}

export const SetTopicAttributesLive = Layer.effect(
  SetTopicAttributes,
  Effect.gen(function* () {
    const Policy = yield* SetTopicAttributesPolicy;
    const setTopicAttributes = yield* sns.setTopicAttributes;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      yield* Policy(topic);
      return Effect.fn(function* (request: SetTopicAttributesRequest) {
        return yield* setTopicAttributes({
          ...request,
          TopicArn: yield* TopicArn,
        });
      });
    });
  }),
);

export class SetTopicAttributesPolicy extends Binding.Policy<
  SetTopicAttributesPolicy,
  (topic: Topic) => Effect.Effect<void>
>()("AWS.SNS.SetTopicAttributes") {}

export const SetTopicAttributesPolicyLive =
  SetTopicAttributesPolicy.layer.succeed(
    Effect.fn(function* (host, topic) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.SNS.SetTopicAttributes(${topic}))`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["sns:SetTopicAttributes"],
              Resource: [topic.topicArn],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `SetTopicAttributesPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";

export interface ListSubscriptionsByTopicRequest extends Omit<
  sns.ListSubscriptionsByTopicInput,
  "TopicArn"
> {}

export class ListSubscriptionsByTopic extends Binding.Service<
  ListSubscriptionsByTopic,
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
>()("AWS.SNS.ListSubscriptionsByTopic") {}

export const ListSubscriptionsByTopicLive = Layer.effect(
  ListSubscriptionsByTopic,
  Effect.gen(function* () {
    const Policy = yield* ListSubscriptionsByTopicPolicy;
    const listSubscriptionsByTopic = yield* sns.listSubscriptionsByTopic;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      yield* Policy(topic);
      return Effect.fn(function* (request?: ListSubscriptionsByTopicRequest) {
        return yield* listSubscriptionsByTopic({
          ...request,
          TopicArn: yield* TopicArn,
        });
      });
    });
  }),
);

export class ListSubscriptionsByTopicPolicy extends Binding.Policy<
  ListSubscriptionsByTopicPolicy,
  (topic: Topic) => Effect.Effect<void>
>()("AWS.SNS.ListSubscriptionsByTopic") {}

export const ListSubscriptionsByTopicPolicyLive =
  ListSubscriptionsByTopicPolicy.layer.succeed(
    Effect.fn(function* (host, topic) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.SNS.ListSubscriptionsByTopic(${topic}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:ListSubscriptionsByTopic"],
                Resource: [topic.topicArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `ListSubscriptionsByTopicPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

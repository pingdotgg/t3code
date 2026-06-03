import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";

export interface PublishRequest extends Omit<
  sns.PublishInput,
  "TopicArn" | "TargetArn" | "PhoneNumber"
> {}

export class Publish extends Binding.Service<
  Publish,
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PublishRequest,
    ) => Effect.Effect<sns.PublishResponse, sns.PublishError>
  >
>()("AWS.SNS.Publish") {}

export const PublishLive = Layer.effect(
  Publish,
  Effect.gen(function* () {
    const Policy = yield* PublishPolicy;
    const publish = yield* sns.publish;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      yield* Policy(topic);
      return Effect.fn(function* (request: PublishRequest) {
        return yield* publish({
          ...request,
          TopicArn: yield* TopicArn,
        });
      });
    });
  }),
);

export class PublishPolicy extends Binding.Policy<
  PublishPolicy,
  (topic: Topic) => Effect.Effect<void>
>()("AWS.SNS.Publish") {}

export const PublishPolicyLive = PublishPolicy.layer.succeed(
  Effect.fn(function* (host, topic) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SNS.Publish(${topic}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["sns:Publish"],
            Resource: [topic.topicArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `PublishPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

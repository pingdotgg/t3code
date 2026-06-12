import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";

export interface PublishBatchRequest extends Omit<
  sns.PublishBatchInput,
  "TopicArn"
> {}

export class PublishBatch extends Binding.Service<
  PublishBatch,
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PublishBatchRequest,
    ) => Effect.Effect<sns.PublishBatchResponse, sns.PublishBatchError>
  >
>()("AWS.SNS.PublishBatch") {}

export const PublishBatchLive = Layer.effect(
  PublishBatch,
  Effect.gen(function* () {
    const Policy = yield* PublishBatchPolicy;
    const publishBatch = yield* sns.publishBatch;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      yield* Policy(topic);
      return Effect.fn(function* (request: PublishBatchRequest) {
        return yield* publishBatch({
          ...request,
          TopicArn: yield* TopicArn,
        });
      });
    });
  }),
);

export class PublishBatchPolicy extends Binding.Policy<
  PublishBatchPolicy,
  (topic: Topic) => Effect.Effect<void>
>()("AWS.SNS.PublishBatch") {}

export const PublishBatchPolicyLive = PublishBatchPolicy.layer.succeed(
  Effect.fn(function* (host, topic) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SNS.PublishBatch(${topic}))`({
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
        `PublishBatchPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

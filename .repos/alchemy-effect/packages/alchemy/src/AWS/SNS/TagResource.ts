import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";

export interface TagResourceRequest extends Omit<
  sns.TagResourceRequest,
  "ResourceArn"
> {}

export class TagResource extends Binding.Service<
  TagResource,
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: TagResourceRequest,
    ) => Effect.Effect<sns.TagResourceResponse, sns.TagResourceError>
  >
>()("AWS.SNS.TagResource") {}

export const TagResourceLive = Layer.effect(
  TagResource,
  Effect.gen(function* () {
    const Policy = yield* TagResourcePolicy;
    const tagResource = yield* sns.tagResource;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      yield* Policy(topic);
      return Effect.fn(function* (request: TagResourceRequest) {
        return yield* tagResource({
          ...request,
          ResourceArn: yield* TopicArn,
        });
      });
    });
  }),
);

export class TagResourcePolicy extends Binding.Policy<
  TagResourcePolicy,
  (topic: Topic) => Effect.Effect<void>
>()("AWS.SNS.TagResource") {}

export const TagResourcePolicyLive = TagResourcePolicy.layer.succeed(
  Effect.fn(function* (host, topic) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SNS.TagResource(${topic}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["sns:TagResource"],
            Resource: [topic.topicArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `TagResourcePolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

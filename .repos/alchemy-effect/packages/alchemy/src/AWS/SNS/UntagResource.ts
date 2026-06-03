import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";

export interface UntagResourceRequest extends Omit<
  sns.UntagResourceRequest,
  "ResourceArn"
> {}

export class UntagResource extends Binding.Service<
  UntagResource,
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: UntagResourceRequest,
    ) => Effect.Effect<sns.UntagResourceResponse, sns.UntagResourceError>
  >
>()("AWS.SNS.UntagResource") {}

export const UntagResourceLive = Layer.effect(
  UntagResource,
  Effect.gen(function* () {
    const Policy = yield* UntagResourcePolicy;
    const untagResource = yield* sns.untagResource;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      yield* Policy(topic);
      return Effect.fn(function* (request: UntagResourceRequest) {
        return yield* untagResource({
          ...request,
          ResourceArn: yield* TopicArn,
        });
      });
    });
  }),
);

export class UntagResourcePolicy extends Binding.Policy<
  UntagResourcePolicy,
  (topic: Topic) => Effect.Effect<void>
>()("AWS.SNS.UntagResource") {}

export const UntagResourcePolicyLive = UntagResourcePolicy.layer.succeed(
  Effect.fn(function* (host, topic) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SNS.UntagResource(${topic}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["sns:UntagResource"],
            Resource: [topic.topicArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `UntagResourcePolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

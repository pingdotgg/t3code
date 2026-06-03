import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";

export interface RemovePermissionRequest extends Omit<
  sns.RemovePermissionInput,
  "TopicArn"
> {}

export class RemovePermission extends Binding.Service<
  RemovePermission,
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: RemovePermissionRequest,
    ) => Effect.Effect<sns.RemovePermissionResponse, sns.RemovePermissionError>
  >
>()("AWS.SNS.RemovePermission") {}

export const RemovePermissionLive = Layer.effect(
  RemovePermission,
  Effect.gen(function* () {
    const Policy = yield* RemovePermissionPolicy;
    const removePermission = yield* sns.removePermission;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      yield* Policy(topic);
      return Effect.fn(function* (request: RemovePermissionRequest) {
        return yield* removePermission({
          ...request,
          TopicArn: yield* TopicArn,
        });
      });
    });
  }),
);

export class RemovePermissionPolicy extends Binding.Policy<
  RemovePermissionPolicy,
  (topic: Topic) => Effect.Effect<void>
>()("AWS.SNS.RemovePermission") {}

export const RemovePermissionPolicyLive = RemovePermissionPolicy.layer.succeed(
  Effect.fn(function* (host, topic) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SNS.RemovePermission(${topic}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["sns:RemovePermission"],
            Resource: [topic.topicArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `RemovePermissionPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

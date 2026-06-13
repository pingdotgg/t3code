import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";

export interface AddPermissionRequest extends Omit<
  sns.AddPermissionInput,
  "TopicArn"
> {}

export class AddPermission extends Binding.Service<
  AddPermission,
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: AddPermissionRequest,
    ) => Effect.Effect<sns.AddPermissionResponse, sns.AddPermissionError>
  >
>()("AWS.SNS.AddPermission") {}

export const AddPermissionLive = Layer.effect(
  AddPermission,
  Effect.gen(function* () {
    const Policy = yield* AddPermissionPolicy;
    const addPermission = yield* sns.addPermission;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      yield* Policy(topic);
      return Effect.fn(function* (request: AddPermissionRequest) {
        return yield* addPermission({
          ...request,
          TopicArn: yield* TopicArn,
        });
      });
    });
  }),
);

export class AddPermissionPolicy extends Binding.Policy<
  AddPermissionPolicy,
  (topic: Topic) => Effect.Effect<void>
>()("AWS.SNS.AddPermission") {}

export const AddPermissionPolicyLive = AddPermissionPolicy.layer.succeed(
  Effect.fn(function* (host, topic) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SNS.AddPermission(${topic}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["sns:AddPermission"],
            Resource: [topic.topicArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `AddPermissionPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

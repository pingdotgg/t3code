import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface ListTopicsRequest extends sns.ListTopicsInput {}

export class ListTopics extends Binding.Service<
  ListTopics,
  () => Effect.Effect<
    (
      request?: ListTopicsRequest,
    ) => Effect.Effect<sns.ListTopicsResponse, sns.ListTopicsError>
  >
>()("AWS.SNS.ListTopics") {}

export const ListTopicsLive = Layer.effect(
  ListTopics,
  Effect.gen(function* () {
    const Policy = yield* ListTopicsPolicy;
    const listTopics = yield* sns.listTopics;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request?: ListTopicsRequest) {
        return yield* listTopics(request ?? {});
      });
    });
  }),
);

export class ListTopicsPolicy extends Binding.Policy<
  ListTopicsPolicy,
  () => Effect.Effect<void>
>()("AWS.SNS.ListTopics") {}

export const ListTopicsPolicyLive = ListTopicsPolicy.layer.succeed(
  Effect.fn(function* (host) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SNS.ListTopics())`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["sns:ListTopics"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `ListTopicsPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";

export interface GetDataProtectionPolicyRequest extends Omit<
  sns.GetDataProtectionPolicyInput,
  "ResourceArn"
> {}

export class GetDataProtectionPolicy extends Binding.Service<
  GetDataProtectionPolicy,
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request?: GetDataProtectionPolicyRequest,
    ) => Effect.Effect<
      sns.GetDataProtectionPolicyResponse,
      sns.GetDataProtectionPolicyError
    >
  >
>()("AWS.SNS.GetDataProtectionPolicy") {}

export const GetDataProtectionPolicyLive = Layer.effect(
  GetDataProtectionPolicy,
  Effect.gen(function* () {
    const Policy = yield* GetDataProtectionPolicyPolicy;
    const getDataProtectionPolicy = yield* sns.getDataProtectionPolicy;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      yield* Policy(topic);
      return Effect.fn(function* (request?: GetDataProtectionPolicyRequest) {
        return yield* getDataProtectionPolicy({
          ...request,
          ResourceArn: yield* TopicArn,
        });
      });
    });
  }),
);

export class GetDataProtectionPolicyPolicy extends Binding.Policy<
  GetDataProtectionPolicyPolicy,
  (topic: Topic) => Effect.Effect<void>
>()("AWS.SNS.GetDataProtectionPolicy") {}

export const GetDataProtectionPolicyPolicyLive =
  GetDataProtectionPolicyPolicy.layer.succeed(
    Effect.fn(function* (host, topic) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.SNS.GetDataProtectionPolicy(${topic}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:GetDataProtectionPolicy"],
                Resource: [topic.topicArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `GetDataProtectionPolicyPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

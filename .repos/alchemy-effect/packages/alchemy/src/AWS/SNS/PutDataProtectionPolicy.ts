import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";

export interface PutDataProtectionPolicyRequest extends Omit<
  sns.PutDataProtectionPolicyInput,
  "ResourceArn"
> {}

export class PutDataProtectionPolicy extends Binding.Service<
  PutDataProtectionPolicy,
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PutDataProtectionPolicyRequest,
    ) => Effect.Effect<
      sns.PutDataProtectionPolicyResponse,
      sns.PutDataProtectionPolicyError
    >
  >
>()("AWS.SNS.PutDataProtectionPolicy") {}

export const PutDataProtectionPolicyLive = Layer.effect(
  PutDataProtectionPolicy,
  Effect.gen(function* () {
    const Policy = yield* PutDataProtectionPolicyPolicy;
    const putDataProtectionPolicy = yield* sns.putDataProtectionPolicy;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      yield* Policy(topic);
      return Effect.fn(function* (request: PutDataProtectionPolicyRequest) {
        return yield* putDataProtectionPolicy({
          ...request,
          ResourceArn: yield* TopicArn,
        });
      });
    });
  }),
);

export class PutDataProtectionPolicyPolicy extends Binding.Policy<
  PutDataProtectionPolicyPolicy,
  (topic: Topic) => Effect.Effect<void>
>()("AWS.SNS.PutDataProtectionPolicy") {}

export const PutDataProtectionPolicyPolicyLive =
  PutDataProtectionPolicyPolicy.layer.succeed(
    Effect.fn(function* (host, topic) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.SNS.PutDataProtectionPolicy(${topic}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:PutDataProtectionPolicy"],
                Resource: [topic.topicArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `PutDataProtectionPolicyPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

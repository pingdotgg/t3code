import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Subscription } from "./Subscription.ts";

export interface ConfirmSubscriptionRequest extends Omit<
  sns.ConfirmSubscriptionInput,
  "TopicArn"
> {}

export class ConfirmSubscription extends Binding.Service<
  ConfirmSubscription,
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: ConfirmSubscriptionRequest,
    ) => Effect.Effect<
      sns.ConfirmSubscriptionResponse,
      sns.ConfirmSubscriptionError
    >
  >
>()("AWS.SNS.ConfirmSubscription") {}

export const ConfirmSubscriptionLive = Layer.effect(
  ConfirmSubscription,
  Effect.gen(function* () {
    const Policy = yield* ConfirmSubscriptionPolicy;
    const confirmSubscription = yield* sns.confirmSubscription;

    return Effect.fn(function* (subscription: Subscription) {
      const TopicArn = yield* subscription.topicArn;
      yield* Policy(subscription);
      return Effect.fn(function* (request: ConfirmSubscriptionRequest) {
        return yield* confirmSubscription({
          ...request,
          TopicArn: yield* TopicArn,
        });
      });
    });
  }),
);

export class ConfirmSubscriptionPolicy extends Binding.Policy<
  ConfirmSubscriptionPolicy,
  (subscription: Subscription) => Effect.Effect<void>
>()("AWS.SNS.ConfirmSubscription") {}

export const ConfirmSubscriptionPolicyLive =
  ConfirmSubscriptionPolicy.layer.succeed(
    Effect.fn(function* (host, subscription) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.SNS.ConfirmSubscription(${subscription}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:ConfirmSubscription"],
                Resource: [subscription.topicArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `ConfirmSubscriptionPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

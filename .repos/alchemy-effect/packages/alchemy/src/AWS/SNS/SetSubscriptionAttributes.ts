import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Subscription } from "./Subscription.ts";

export interface SetSubscriptionAttributesRequest extends Omit<
  sns.SetSubscriptionAttributesInput,
  "SubscriptionArn"
> {}

export class SetSubscriptionAttributes extends Binding.Service<
  SetSubscriptionAttributes,
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: SetSubscriptionAttributesRequest,
    ) => Effect.Effect<
      sns.SetSubscriptionAttributesResponse,
      sns.SetSubscriptionAttributesError
    >
  >
>()("AWS.SNS.SetSubscriptionAttributes") {}

export const SetSubscriptionAttributesLive = Layer.effect(
  SetSubscriptionAttributes,
  Effect.gen(function* () {
    const Policy = yield* SetSubscriptionAttributesPolicy;
    const setSubscriptionAttributes = yield* sns.setSubscriptionAttributes;

    return Effect.fn(function* (subscription: Subscription) {
      const SubscriptionArn = yield* subscription.subscriptionArn;
      yield* Policy(subscription);
      return Effect.fn(function* (request: SetSubscriptionAttributesRequest) {
        return yield* setSubscriptionAttributes({
          ...request,
          SubscriptionArn: yield* SubscriptionArn,
        });
      });
    });
  }),
);

export class SetSubscriptionAttributesPolicy extends Binding.Policy<
  SetSubscriptionAttributesPolicy,
  (subscription: Subscription) => Effect.Effect<void>
>()("AWS.SNS.SetSubscriptionAttributes") {}

export const SetSubscriptionAttributesPolicyLive =
  SetSubscriptionAttributesPolicy.layer.succeed(
    Effect.fn(function* (host, subscription) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.SNS.SetSubscriptionAttributes(${subscription}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:SetSubscriptionAttributes"],
                Resource: [subscription.topicArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `SetSubscriptionAttributesPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Subscription } from "./Subscription.ts";

export interface GetSubscriptionAttributesRequest extends Omit<
  sns.GetSubscriptionAttributesInput,
  "SubscriptionArn"
> {}

export class GetSubscriptionAttributes extends Binding.Service<
  GetSubscriptionAttributes,
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request?: GetSubscriptionAttributesRequest,
    ) => Effect.Effect<
      sns.GetSubscriptionAttributesResponse,
      sns.GetSubscriptionAttributesError
    >
  >
>()("AWS.SNS.GetSubscriptionAttributes") {}

export const GetSubscriptionAttributesLive = Layer.effect(
  GetSubscriptionAttributes,
  Effect.gen(function* () {
    const Policy = yield* GetSubscriptionAttributesPolicy;
    const getSubscriptionAttributes = yield* sns.getSubscriptionAttributes;

    return Effect.fn(function* (subscription: Subscription) {
      const SubscriptionArn = yield* subscription.subscriptionArn;
      yield* Policy(subscription);
      return Effect.fn(function* (request?: GetSubscriptionAttributesRequest) {
        return yield* getSubscriptionAttributes({
          ...request,
          SubscriptionArn: yield* SubscriptionArn,
        });
      });
    });
  }),
);

export class GetSubscriptionAttributesPolicy extends Binding.Policy<
  GetSubscriptionAttributesPolicy,
  (subscription: Subscription) => Effect.Effect<void>
>()("AWS.SNS.GetSubscriptionAttributes") {}

export const GetSubscriptionAttributesPolicyLive =
  GetSubscriptionAttributesPolicy.layer.succeed(
    Effect.fn(function* (host, subscription) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.SNS.GetSubscriptionAttributes(${subscription}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:GetSubscriptionAttributes"],
                Resource: [subscription.topicArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `GetSubscriptionAttributesPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

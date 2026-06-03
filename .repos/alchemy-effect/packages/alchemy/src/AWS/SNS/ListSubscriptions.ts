import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface ListSubscriptionsRequest extends sns.ListSubscriptionsInput {}

export class ListSubscriptions extends Binding.Service<
  ListSubscriptions,
  () => Effect.Effect<
    (
      request?: ListSubscriptionsRequest,
    ) => Effect.Effect<
      sns.ListSubscriptionsResponse,
      sns.ListSubscriptionsError
    >
  >
>()("AWS.SNS.ListSubscriptions") {}

export const ListSubscriptionsLive = Layer.effect(
  ListSubscriptions,
  Effect.gen(function* () {
    const Policy = yield* ListSubscriptionsPolicy;
    const listSubscriptions = yield* sns.listSubscriptions;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request?: ListSubscriptionsRequest) {
        return yield* listSubscriptions(request ?? {});
      });
    });
  }),
);

export class ListSubscriptionsPolicy extends Binding.Policy<
  ListSubscriptionsPolicy,
  () => Effect.Effect<void>
>()("AWS.SNS.ListSubscriptions") {}

export const ListSubscriptionsPolicyLive =
  ListSubscriptionsPolicy.layer.succeed(
    Effect.fn(function* (host) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.SNS.ListSubscriptions())`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["sns:ListSubscriptions"],
              Resource: ["*"],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `ListSubscriptionsPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface ListEventBusesRequest
  extends eventbridge.ListEventBusesRequest {}

export class ListEventBuses extends Binding.Service<
  ListEventBuses,
  () => Effect.Effect<
    (
      request?: ListEventBusesRequest,
    ) => Effect.Effect<
      eventbridge.ListEventBusesResponse,
      eventbridge.ListEventBusesError
    >
  >
>()("AWS.EventBridge.ListEventBuses") {}

export const ListEventBusesLive = Layer.effect(
  ListEventBuses,
  Effect.gen(function* () {
    const Policy = yield* ListEventBusesPolicy;
    const listEventBuses = yield* eventbridge.listEventBuses;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request?: ListEventBusesRequest) {
        return yield* listEventBuses(request ?? {});
      });
    });
  }),
);

export class ListEventBusesPolicy extends Binding.Policy<
  ListEventBusesPolicy,
  () => Effect.Effect<void>
>()("AWS.EventBridge.ListEventBuses") {}

export const ListEventBusesPolicyLive = ListEventBusesPolicy.layer.succeed(
  Effect.fn(function* (host) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.EventBridge.ListEventBuses())`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["events:ListEventBuses"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `ListEventBusesPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { EventBus } from "./EventBus.ts";

export interface DescribeEventBusRequest extends Omit<
  eventbridge.DescribeEventBusRequest,
  "Name"
> {}

export class DescribeEventBus extends Binding.Service<
  DescribeEventBus,
  (
    bus: EventBus,
  ) => Effect.Effect<
    (
      request?: DescribeEventBusRequest,
    ) => Effect.Effect<
      eventbridge.DescribeEventBusResponse,
      eventbridge.DescribeEventBusError
    >
  >
>()("AWS.EventBridge.DescribeEventBus") {}

export const DescribeEventBusLive = Layer.effect(
  DescribeEventBus,
  Effect.gen(function* () {
    const Policy = yield* DescribeEventBusPolicy;
    const describeEventBus = yield* eventbridge.describeEventBus;

    return Effect.fn(function* (bus: EventBus) {
      const Name = yield* bus.eventBusName;
      yield* Policy(bus);
      return Effect.fn(function* (request?: DescribeEventBusRequest) {
        return yield* describeEventBus({
          ...request,
          Name: yield* Name,
        });
      });
    });
  }),
);

export class DescribeEventBusPolicy extends Binding.Policy<
  DescribeEventBusPolicy,
  (bus: EventBus) => Effect.Effect<void>
>()("AWS.EventBridge.DescribeEventBus") {}

export const DescribeEventBusPolicyLive = DescribeEventBusPolicy.layer.succeed(
  Effect.fn(function* (host, bus) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.EventBridge.DescribeEventBus(${bus}))`(
        {
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["events:DescribeEventBus"],
              Resource: [bus.eventBusArn],
            },
          ],
        },
      );
    } else {
      return yield* Effect.die(
        `DescribeEventBusPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

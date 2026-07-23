import { Region } from "@distilled.cloud/aws/Region";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { EventBus } from "./EventBus.ts";

export interface ListRulesRequest extends Omit<
  eventbridge.ListRulesRequest,
  "EventBusName"
> {}

export class ListRules extends Binding.Service<
  ListRules,
  (
    bus?: EventBus,
  ) => Effect.Effect<
    (
      request?: ListRulesRequest,
    ) => Effect.Effect<
      eventbridge.ListRulesResponse,
      eventbridge.ListRulesError
    >
  >
>()("AWS.EventBridge.ListRules") {}

export const ListRulesLive = Layer.effect(
  ListRules,
  Effect.gen(function* () {
    const Policy = yield* ListRulesPolicy;
    const listRules = yield* eventbridge.listRules;

    return Effect.fn(function* (bus?: EventBus) {
      const EventBusName = bus ? yield* bus.eventBusName : undefined;
      yield* Policy(bus);
      return Effect.fn(function* (request?: ListRulesRequest) {
        const eventBusName = EventBusName ? yield* EventBusName : undefined;
        return yield* listRules({
          ...request,
          EventBusName:
            eventBusName && eventBusName !== "default"
              ? eventBusName
              : undefined,
        });
      });
    });
  }),
);

export class ListRulesPolicy extends Binding.Policy<
  ListRulesPolicy,
  (bus?: EventBus) => Effect.Effect<void>
>()("AWS.EventBridge.ListRules") {}

export const ListRulesPolicyLive = ListRulesPolicy.layer.effect(
  Effect.gen(function* () {
    const region = yield* Region;
    const { accountId } = yield* AWSEnvironment;

    return Effect.fn(function* (host, bus?: EventBus) {
      if (isFunction(host)) {
        const resource = bus
          ? Output.interpolate`${bus.eventBusArn}`
          : (`arn:aws:events:${region}:${accountId}:event-bus/default` as const);

        yield* host.bind`Allow(${host}, AWS.EventBridge.ListRules(${bus ?? "default"}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["events:ListRules"],
                Resource: [resource],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `ListRulesPolicy does not support runtime '${host.Type}'`,
        );
      }
    });
  }),
);

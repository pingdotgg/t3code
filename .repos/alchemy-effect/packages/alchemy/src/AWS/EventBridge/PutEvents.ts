import { Region } from "@distilled.cloud/aws/Region";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { EventBus } from "./EventBus.ts";

export interface PutEventsRequest extends Omit<
  eventbridge.PutEventsRequest,
  "Entries"
> {
  Entries: Array<Omit<eventbridge.PutEventsRequestEntry, "EventBusName">>;
}

export class PutEvents extends Binding.Service<
  PutEvents,
  (
    bus?: EventBus,
  ) => Effect.Effect<
    (
      request: PutEventsRequest,
    ) => Effect.Effect<
      eventbridge.PutEventsResponse,
      eventbridge.PutEventsError
    >
  >
>()("AWS.EventBridge.PutEvents") {}

export const PutEventsLive = Layer.effect(
  PutEvents,
  Effect.gen(function* () {
    const Policy = yield* PutEventsPolicy;
    const putEvents = yield* eventbridge.putEvents;

    return Effect.fn(function* (bus?: EventBus) {
      const EventBusName = bus ? yield* bus.eventBusName : undefined;
      yield* Policy(bus);
      return Effect.fn(function* (request: PutEventsRequest) {
        const eventBusName = EventBusName ? yield* EventBusName : undefined;
        return yield* putEvents({
          ...request,
          Entries: request.Entries.map((entry) => ({
            ...entry,
            EventBusName:
              eventBusName && eventBusName !== "default"
                ? eventBusName
                : undefined,
          })),
        });
      });
    });
  }),
);

export class PutEventsPolicy extends Binding.Policy<
  PutEventsPolicy,
  (bus?: EventBus) => Effect.Effect<void>
>()("AWS.EventBridge.PutEvents") {}

export const PutEventsPolicyLive = PutEventsPolicy.layer.effect(
  Effect.gen(function* () {
    const region = yield* Region;
    const { accountId } = yield* AWSEnvironment;

    return Effect.fn(function* (host, bus?: EventBus) {
      if (isFunction(host)) {
        const resource = bus
          ? yield* yield* bus.eventBusArn
          : (`arn:aws:events:${region}:${accountId}:event-bus/default` as const);

        yield* host.bind`Allow(${host}, AWS.EventBridge.PutEvents(${bus ?? "default"}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["events:PutEvents"],
                Resource: [resource],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `PutEventsPolicy does not support runtime '${host.Type}'`,
        );
      }
    });
  }),
);

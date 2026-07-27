import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { EventBus } from "./EventBus.ts";
import { PutEvents, type PutEventsRequest } from "./PutEvents.ts";

/**
 * HTTP implementation of {@link PutEvents}. At deploy time it grants
 * `events:PutEvents` on the bound bus (or the default bus); at runtime it
 * calls the EventBridge API with the host Function's credentials. Provide
 * this layer on the Function using the binding.
 */
export const PutEventsHttp = Layer.effect(
  PutEvents,
  Effect.gen(function* () {
    const putEvents = yield* eventbridge.putEvents;

    return Effect.fn(function* (bus?: EventBus) {
      const EventBusName = bus ? yield* bus.eventBusName : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          // Pass the ARN as an unresolved Output — binding data is resolved
          // by the engine before the host reconciles. Eagerly yielding here
          // (during plan) produces a deferred object that serializes into an
          // invalid IAM policy (MalformedPolicyDocumentException).
          const resource = bus
            ? Output.interpolate`${bus.eventBusArn}`
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
        }
      }
      return Effect.fn(`AWS.EventBridge.PutEvents(${bus?.LogicalId})`)(
        function* (request: PutEventsRequest) {
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
        },
      );
    });
  }),
);

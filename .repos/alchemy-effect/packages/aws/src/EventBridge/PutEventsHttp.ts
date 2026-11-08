import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Output from "alchemy/Output";
import { isResourceOfType } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Endpoint } from "./Endpoint.ts";
import type { EventBus } from "./EventBus.ts";
import { PutEvents, type PutEventsRequest } from "./PutEvents.ts";

/**
 * HTTP implementation of {@link PutEvents}. At deploy time it grants
 * `events:PutEvents` on the bound bus (or the default bus, or both buses of a
 * global endpoint); at runtime it calls the EventBridge API with the host
 * Function's credentials. Provide this layer on the Function using the
 * binding.
 */
export const PutEventsHttp = Layer.effect(
  PutEvents,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const putEvents = yield* AWSBindings.withCredentials(eventbridge.putEvents);

    /**
     * Publish through a global endpoint: requests go to the endpoint's URL
     * (signed with SigV4A) and EventBridge routes them to the healthy
     * region's bus. Both buses are granted, since either may receive them.
     */
    const bindEndpoint = Effect.fn(function* (endpoint: Endpoint) {
      const EndpointId = yield* endpoint.endpointId;
      const EventBusArns = yield* endpoint.eventBusArns;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.EventBridge.PutEvents(${endpoint})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["events:PutEvents"],
              Resource: endpoint.eventBusArns,
            },
          ],
        });
      }
      return Effect.fn(`AWS.EventBridge.PutEvents(${endpoint.LogicalId})`)(function* (
        request: PutEventsRequest,
      ) {
        const endpointId = yield* EndpointId;
        // Both buses share a name; the endpoint resolves it in whichever
        // region it routes to.
        const [primary] = yield* EventBusArns;
        const eventBusName = primary!.slice(primary!.indexOf(":event-bus/") + ":event-bus/".length);
        return yield* putEvents({
          ...request,
          EndpointId: endpointId,
          Entries: request.Entries.map((entry) => ({ ...entry, EventBusName: eventBusName })),
        });
      });
    });

    return Effect.fn(function* (target?: EventBus | Endpoint) {
      if (isResourceOfType(target, "AWS.EventBridge.Endpoint")) {
        return yield* bindEndpoint(target as Endpoint);
      }
      const bus = target as EventBus | undefined;
      const EventBusName = bus ? yield* bus.eventBusName : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const { accountId, region } = yield* AWSEnvironment.current as unknown as Effect.Effect<{
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

        yield* bind`AWS.EventBridge.PutEvents(${bus ?? "default"})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["events:PutEvents"],
              Resource: [resource],
            },
          ],
        });
      }
      return Effect.fn(`AWS.EventBridge.PutEvents(${bus?.LogicalId})`)(function* (
        request: PutEventsRequest,
      ) {
        const eventBusName = EventBusName ? yield* EventBusName : undefined;
        return yield* putEvents({
          ...request,
          Entries: request.Entries.map((entry) => ({
            ...entry,
            EventBusName: eventBusName && eventBusName !== "default" ? eventBusName : undefined,
          })),
        });
      });
    });
  }),
);

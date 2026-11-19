import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { Endpoint } from "./Endpoint.ts";
import type { EventBus } from "./EventBus.ts";

export interface PutEventsRequest extends Omit<eventbridge.PutEventsRequest, "Entries"> {
  Entries: Array<Omit<eventbridge.PutEventsRequestEntry, "EventBusName">>;
}

/**
 * Publishes events to an EventBridge event bus (`events:PutEvents`).
 *
 * Bind this operation to an {@link EventBus} inside a function runtime to get
 * a callable that automatically injects the bus name into every entry. Omit
 * the bus argument to publish to the account's default event bus, or bind a
 * global {@link Endpoint} to publish through it (EventBridge routes each
 * event to the healthy region's bus). Provide the `PutEventsHttp` layer on
 * the Function to satisfy the binding.
 * ### Publishing Events
 * **Example:** Publish an Event from a Handler
 * ```typescript
 * // init — bind the bus (provide AWS.EventBridge.PutEventsHttp on the Function)
 * const putEvents = yield* AWS.EventBridge.PutEvents(bus);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime — publish an event
 *     const result = yield* putEvents({
 *       Entries: [
 *         {
 *           Source: "my.app",
 *           DetailType: "OrderCreated",
 *           Detail: JSON.stringify({ orderId: "123" }),
 *         },
 *       ],
 *     });
 *     return HttpServerResponse.json({
 *       failedEntryCount: result.FailedEntryCount ?? 0,
 *     });
 *   }),
 * };
 * ```
 *
 * **Example:** Publish to the Default Event Bus
 * ```typescript
 * // omit the bus argument to target the account's default bus
 * const putEvents = yield* AWS.EventBridge.PutEvents();
 *
 * yield* putEvents({
 *   Entries: [
 *     {
 *       Source: "my.app",
 *       DetailType: "Heartbeat",
 *       Detail: JSON.stringify({ at: new Date().toISOString() }),
 *     },
 *   ],
 * });
 * ```
 *
 * ### Publishing Through a Global Endpoint
 * **Example:** Publish to a Multi-Region Endpoint
 * ```typescript
 * const putEvents = yield* AWS.EventBridge.PutEvents(endpoint);
 *
 * yield* putEvents({
 *   Entries: [
 *     {
 *       Source: "my.app",
 *       DetailType: "OrderCreated",
 *       Detail: JSON.stringify({ orderId: "123" }),
 *     },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface PutEvents extends Binding.Service<
  PutEvents,
  "AWS.EventBridge.PutEvents",
  (
    target?: EventBus | Endpoint,
  ) => Effect.Effect<
    (
      request: PutEventsRequest,
    ) => Effect.Effect<eventbridge.PutEventsResponse, eventbridge.PutEventsError>
  >
> {}
export const PutEvents = Binding.Service<PutEvents>("AWS.EventBridge.PutEvents");

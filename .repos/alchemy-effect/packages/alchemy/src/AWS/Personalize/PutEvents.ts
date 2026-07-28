import type * as personalizeevents from "@distilled.cloud/aws/personalize-events";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventTracker } from "./EventTracker.ts";

/**
 * `PutEvents` request with `trackingId` injected from the bound tracker.
 */
export interface PutEventsRequest extends Omit<
  personalizeevents.PutEventsRequest,
  "trackingId"
> {}

/**
 * Runtime binding for `personalize:PutEvents`, scoped to one {@link EventTracker} —
 * Records item-interaction events (clicks, views, purchases, …) in real
 * time through the bound {@link EventTracker}. Events stream into the
 * dataset group's Interactions dataset and are used by recommenders as
 * they happen.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.PutEventsHttp)`.
 *
 * @binding
 * @section Streaming Events
 * @example Record a Click Event
 * ```typescript
 * // init
 * const putEvents = yield* Personalize.PutEvents(tracker);
 *
 * yield* putEvents({
 *   sessionId: "session-1",
 *   userId: "user-1",
 *   eventList: [{ eventType: "click", itemId: "item-42", sentAt: new Date() }],
 * });
 * ```
 */
export interface PutEvents extends Binding.Service<
  PutEvents,
  "AWS.Personalize.PutEvents",
  (
    tracker: EventTracker,
  ) => Effect.Effect<
    (
      request: PutEventsRequest,
    ) => Effect.Effect<
      personalizeevents.PutEventsResponse,
      personalizeevents.PutEventsError
    >
  >
> {}
export const PutEvents = Binding.Service<PutEvents>(
  "AWS.Personalize.PutEvents",
);

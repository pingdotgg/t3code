import type * as personalizeevents from "@distilled.cloud/aws/personalize-events";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventTracker } from "./EventTracker.ts";

/**
 * `PutActionInteractions` request with `trackingId` injected from the bound tracker.
 */
export interface PutActionInteractionsRequest extends Omit<
  personalizeevents.PutActionInteractionsRequest,
  "trackingId"
> {}

/**
 * Runtime binding for `personalize:PutActionInteractions`, scoped to one {@link EventTracker} —
 * Records action-interaction events (Taken, Not Taken, Viewed) for the
 * NEXT_BEST_ACTION recipe through the bound {@link EventTracker}. Events
 * stream into the dataset group's Action interactions dataset.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.PutActionInteractionsHttp)`.
 *
 * @binding
 * @section Streaming Events
 * @example Record an Action Interaction
 * ```typescript
 * // init
 * const putActionInteractions = yield* Personalize.PutActionInteractions(tracker);
 *
 * yield* putActionInteractions({
 *   actionInteractions: [{
 *     actionId: "action-1",
 *     userId: "user-1",
 *     sessionId: "session-1",
 *     eventType: "Taken",
 *     timestamp: new Date(),
 *   }],
 * });
 * ```
 */
export interface PutActionInteractions extends Binding.Service<
  PutActionInteractions,
  "AWS.Personalize.PutActionInteractions",
  (
    tracker: EventTracker,
  ) => Effect.Effect<
    (
      request: PutActionInteractionsRequest,
    ) => Effect.Effect<
      personalizeevents.PutActionInteractionsResponse,
      personalizeevents.PutActionInteractionsError
    >
  >
> {}
export const PutActionInteractions = Binding.Service<PutActionInteractions>(
  "AWS.Personalize.PutActionInteractions",
);

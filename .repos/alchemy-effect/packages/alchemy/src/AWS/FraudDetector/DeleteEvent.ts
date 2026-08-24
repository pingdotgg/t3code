import type * as frauddetector from "@distilled.cloud/aws/frauddetector";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventType } from "./EventType.ts";

/**
 * The `eventTypeName` is injected by the binding from the bound event type;
 * the `eventId` and optional `deleteAuditHistory` flag remain.
 */
export interface DeleteEventRequest extends Omit<
  frauddetector.DeleteEventRequest,
  "eventTypeName"
> {}

/**
 * Delete a stored event from Amazon Fraud Detector — the effectful erasure
 * call made from a deployed Lambda or Task, e.g. to honor a data-deletion
 * request. Set `deleteAuditHistory` to also remove the event's prediction
 * history.
 *
 * @binding
 * @section Deleting Stored Events
 * Provide the `DeleteEventHttp` implementation layer on the Function effect,
 * bind the event type in the init phase, then call the returned client at
 * runtime. The binding grants `frauddetector:DeleteEvent` on the event type
 * and injects its `eventTypeName` automatically.
 *
 * @example Delete from a Lambda
 * ```typescript
 * // init
 * const deleteEvent = yield* FraudDetector.DeleteEvent(eventType);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* deleteEvent({ eventId: "order-123", deleteAuditHistory: true });
 *     return HttpServerResponse.json({ ok: true });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(FraudDetector.DeleteEventHttp))
 * ```
 */
export interface DeleteEvent extends Binding.Service<
  DeleteEvent,
  "AWS.FraudDetector.DeleteEvent",
  (
    eventType: EventType,
  ) => Effect.Effect<
    (
      request: DeleteEventRequest,
    ) => Effect.Effect<
      frauddetector.DeleteEventResult,
      frauddetector.DeleteEventError
    >
  >
> {}
export const DeleteEvent = Binding.Service<DeleteEvent>(
  "AWS.FraudDetector.DeleteEvent",
);

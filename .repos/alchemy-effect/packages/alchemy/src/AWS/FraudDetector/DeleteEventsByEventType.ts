import type * as frauddetector from "@distilled.cloud/aws/frauddetector";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventType } from "./EventType.ts";

/**
 * The `eventTypeName` is injected by the binding from the bound event type;
 * the request carries nothing else.
 */
export interface DeleteEventsByEventTypeRequest extends Omit<
  frauddetector.DeleteEventsByEventTypeRequest,
  "eventTypeName"
> {}

/**
 * Start an asynchronous bulk delete of ALL events stored for a bound Amazon
 * Fraud Detector event type — the effectful cleanup call (e.g. a data-privacy
 * purge) made from a deployed Lambda or Task. Track progress with the
 * companion `GetDeleteEventsByEventTypeStatus` binding.
 *
 * @binding
 * @section Purging Stored Events
 * Provide the `DeleteEventsByEventTypeHttp` implementation layer on the
 * Function effect, bind the event type in the init phase, then call the
 * returned client at runtime. The binding grants
 * `frauddetector:DeleteEventsByEventType` on the event type and injects its
 * `eventTypeName` automatically.
 *
 * @example Purge from a Lambda
 * ```typescript
 * // init
 * const deleteEventsByEventType =
 *   yield* FraudDetector.DeleteEventsByEventType(eventType);
 * const getDeleteStatus =
 *   yield* FraudDetector.GetDeleteEventsByEventTypeStatus(eventType);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* deleteEventsByEventType({});
 *     const { eventsDeletionStatus } = yield* getDeleteStatus({});
 *     return HttpServerResponse.json({ status: eventsDeletionStatus });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(Layer.mergeAll(
 * //   FraudDetector.DeleteEventsByEventTypeHttp,
 * //   FraudDetector.GetDeleteEventsByEventTypeStatusHttp,
 * // )))
 * ```
 */
export interface DeleteEventsByEventType extends Binding.Service<
  DeleteEventsByEventType,
  "AWS.FraudDetector.DeleteEventsByEventType",
  (
    eventType: EventType,
  ) => Effect.Effect<
    (
      request: DeleteEventsByEventTypeRequest,
    ) => Effect.Effect<
      frauddetector.DeleteEventsByEventTypeResult,
      frauddetector.DeleteEventsByEventTypeError
    >
  >
> {}
export const DeleteEventsByEventType = Binding.Service<DeleteEventsByEventType>(
  "AWS.FraudDetector.DeleteEventsByEventType",
);

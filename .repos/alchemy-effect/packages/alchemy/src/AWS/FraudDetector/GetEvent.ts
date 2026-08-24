import type * as frauddetector from "@distilled.cloud/aws/frauddetector";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventType } from "./EventType.ts";

/**
 * The `eventTypeName` is injected by the binding from the bound event type;
 * only the `eventId` remains.
 */
export interface GetEventRequest extends Omit<
  frauddetector.GetEventRequest,
  "eventTypeName"
> {}

/**
 * Read a stored event (its entities and variable values) back from Amazon
 * Fraud Detector — the effectful lookup call made from a deployed Lambda or
 * Task. Events are stored by `SendEvent` or by predictions on an event type
 * with ingestion enabled.
 *
 * @binding
 * @section Reading Stored Events
 * Provide the `GetEventHttp` implementation layer on the Function effect,
 * bind the event type in the init phase, then call the returned client at
 * runtime. The binding grants `frauddetector:GetEvent` on the event type and
 * injects its `eventTypeName` automatically.
 *
 * @example Read from a Lambda
 * ```typescript
 * // init
 * const getEvent = yield* FraudDetector.GetEvent(eventType);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const { event } = yield* getEvent({ eventId: "order-123" });
 *     return HttpServerResponse.json({ variables: event?.eventVariables });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(FraudDetector.GetEventHttp))
 * ```
 */
export interface GetEvent extends Binding.Service<
  GetEvent,
  "AWS.FraudDetector.GetEvent",
  (
    eventType: EventType,
  ) => Effect.Effect<
    (
      request: GetEventRequest,
    ) => Effect.Effect<
      frauddetector.GetEventResult,
      frauddetector.GetEventError
    >
  >
> {}
export const GetEvent = Binding.Service<GetEvent>("AWS.FraudDetector.GetEvent");

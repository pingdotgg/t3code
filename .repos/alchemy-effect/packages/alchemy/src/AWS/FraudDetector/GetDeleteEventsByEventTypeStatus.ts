import type * as frauddetector from "@distilled.cloud/aws/frauddetector";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventType } from "./EventType.ts";

/**
 * The `eventTypeName` is injected by the binding from the bound event type;
 * the request carries nothing else.
 */
export interface GetDeleteEventsByEventTypeStatusRequest extends Omit<
  frauddetector.GetDeleteEventsByEventTypeStatusRequest,
  "eventTypeName"
> {}

/**
 * Check the status of an asynchronous bulk event delete started by
 * `DeleteEventsByEventType` on a bound Amazon Fraud Detector event type — the
 * effectful status poll made from a deployed Lambda or Task.
 *
 * @binding
 * @section Purging Stored Events
 * Provide the `GetDeleteEventsByEventTypeStatusHttp` implementation layer on
 * the Function effect, bind the event type in the init phase, then call the
 * returned client at runtime. The binding grants
 * `frauddetector:GetDeleteEventsByEventTypeStatus` on the event type and
 * injects its `eventTypeName` automatically.
 *
 * @example Poll from a Lambda
 * ```typescript
 * // init
 * const getDeleteStatus =
 *   yield* FraudDetector.GetDeleteEventsByEventTypeStatus(eventType);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const { eventsDeletionStatus } = yield* getDeleteStatus({});
 *     return HttpServerResponse.json({ status: eventsDeletionStatus });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(FraudDetector.GetDeleteEventsByEventTypeStatusHttp))
 * ```
 */
export interface GetDeleteEventsByEventTypeStatus extends Binding.Service<
  GetDeleteEventsByEventTypeStatus,
  "AWS.FraudDetector.GetDeleteEventsByEventTypeStatus",
  (
    eventType: EventType,
  ) => Effect.Effect<
    (
      request: GetDeleteEventsByEventTypeStatusRequest,
    ) => Effect.Effect<
      frauddetector.GetDeleteEventsByEventTypeStatusResult,
      frauddetector.GetDeleteEventsByEventTypeStatusError
    >
  >
> {}
export const GetDeleteEventsByEventTypeStatus =
  Binding.Service<GetDeleteEventsByEventTypeStatus>(
    "AWS.FraudDetector.GetDeleteEventsByEventTypeStatus",
  );

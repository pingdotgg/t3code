import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetInternetEventRequest extends im.GetInternetEventInput {}

/**
 * Runtime binding for `internetmonitor:GetInternetEvent` — read the detail
 * (impacted client location, start/end time, type, status) of one global
 * internet event from the outages map Internet Monitor publishes for all
 * AWS customers. Internet events are account-level; no monitor is required.
 *
 * Provide `InternetMonitor.GetInternetEventHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Internet Events
 * @example Read an Internet Event by Id
 * ```typescript
 * // init — grants internetmonitor:GetInternetEvent
 * const getInternetEvent = yield* AWS.InternetMonitor.GetInternetEvent();
 *
 * // runtime
 * const event = yield* getInternetEvent({ EventId: eventId });
 * const location = event.ClientLocation;
 * ```
 */
export interface GetInternetEvent extends Binding.Service<
  GetInternetEvent,
  "AWS.InternetMonitor.GetInternetEvent",
  () => Effect.Effect<
    (
      request: GetInternetEventRequest,
    ) => Effect.Effect<im.GetInternetEventOutput, im.GetInternetEventError>
  >
> {}

export const GetInternetEvent = Binding.Service<GetInternetEvent>(
  "AWS.InternetMonitor.GetInternetEvent",
);

import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Monitor } from "./Monitor.ts";

export interface GetHealthEventRequest extends Omit<
  im.GetHealthEventInput,
  "MonitorName"
> {}

/**
 * Runtime binding for `internetmonitor:GetHealthEvent` — read the full
 * detail (impacted locations, availability/performance measurements, impact
 * type) of one health event on the bound {@link Monitor}; the monitor name
 * is injected automatically.
 *
 * Provide `InternetMonitor.GetHealthEventHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Health Events
 * @example Read a Health Event by Id
 * ```typescript
 * // init — grants internetmonitor:GetHealthEvent on the monitor
 * const getHealthEvent = yield* AWS.InternetMonitor.GetHealthEvent(monitor);
 *
 * // runtime
 * const event = yield* getHealthEvent({ EventId: eventId });
 * const locations = event.ImpactedLocations;
 * ```
 */
export interface GetHealthEvent extends Binding.Service<
  GetHealthEvent,
  "AWS.InternetMonitor.GetHealthEvent",
  (
    monitor: Monitor,
  ) => Effect.Effect<
    (
      request: GetHealthEventRequest,
    ) => Effect.Effect<im.GetHealthEventOutput, im.GetHealthEventError>
  >
> {}

export const GetHealthEvent = Binding.Service<GetHealthEvent>(
  "AWS.InternetMonitor.GetHealthEvent",
);

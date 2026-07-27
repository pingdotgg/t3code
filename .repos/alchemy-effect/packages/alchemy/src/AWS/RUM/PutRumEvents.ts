import type * as rum from "@distilled.cloud/aws/rum";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AppMonitor } from "./AppMonitor.ts";

export interface PutRumEventsRequest extends Omit<
  rum.PutRumEventsRequest,
  "Id" | "AppMonitorDetails"
> {
  /**
   * Details of the app monitor sending the events. Defaults to the bound
   * monitor's name and id.
   */
  AppMonitorDetails?: rum.AppMonitorDetails;
}

/**
 * Runtime binding for `rum:PutRumEvents` — send a batch of telemetry events
 * from one user session to the bound {@link AppMonitor}'s data plane (the
 * same operation the RUM web client uses); the monitor id and details are
 * injected automatically.
 *
 * Provide `RUM.PutRumEventsHttp` on the hosting Lambda Function to satisfy
 * the requirement.
 * @binding
 * @section Sending RUM Events
 * @example Send a Session's Events Server-Side
 * ```typescript
 * // init — grants rum:PutRumEvents on the monitor
 * const putRumEvents = yield* AWS.RUM.PutRumEvents(monitor);
 *
 * // runtime
 * yield* putRumEvents({
 *   BatchId: crypto.randomUUID(),
 *   UserDetails: { userId, sessionId },
 *   RumEvents: [
 *     {
 *       id: crypto.randomUUID(),
 *       timestamp: new Date(),
 *       type: "com.amazon.rum.session_start_event",
 *       details: "{}",
 *     },
 *   ],
 * });
 * ```
 */
export interface PutRumEvents extends Binding.Service<
  PutRumEvents,
  "AWS.RUM.PutRumEvents",
  (
    monitor: AppMonitor,
  ) => Effect.Effect<
    (
      request: PutRumEventsRequest,
    ) => Effect.Effect<rum.PutRumEventsResponse, rum.PutRumEventsError>
  >
> {}

export const PutRumEvents = Binding.Service<PutRumEvents>(
  "AWS.RUM.PutRumEvents",
);

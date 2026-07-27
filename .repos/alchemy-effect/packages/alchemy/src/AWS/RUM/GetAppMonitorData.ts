import type * as rum from "@distilled.cloud/aws/rum";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AppMonitor } from "./AppMonitor.ts";

export interface GetAppMonitorDataRequest extends Omit<
  rum.GetAppMonitorDataRequest,
  "Name"
> {}

/**
 * Runtime binding for `rum:GetAppMonitorData` — retrieve the raw performance
 * and error events that CloudWatch RUM collected from the bound
 * {@link AppMonitor} for your own processing or analysis; the monitor name
 * is injected automatically.
 *
 * Provide `RUM.GetAppMonitorDataHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Reading RUM Telemetry
 * @example Read the Trailing Hour of Events
 * ```typescript
 * // init — grants rum:GetAppMonitorData on the monitor
 * const getAppMonitorData = yield* AWS.RUM.GetAppMonitorData(monitor);
 *
 * // runtime — each event is a JSON string
 * const now = Date.now();
 * const { Events } = yield* getAppMonitorData({
 *   TimeRange: { After: now - 3_600_000, Before: now },
 * });
 * ```
 */
export interface GetAppMonitorData extends Binding.Service<
  GetAppMonitorData,
  "AWS.RUM.GetAppMonitorData",
  (
    monitor: AppMonitor,
  ) => Effect.Effect<
    (
      request: GetAppMonitorDataRequest,
    ) => Effect.Effect<
      rum.GetAppMonitorDataResponse,
      rum.GetAppMonitorDataError
    >
  >
> {}

export const GetAppMonitorData = Binding.Service<GetAppMonitorData>(
  "AWS.RUM.GetAppMonitorData",
);

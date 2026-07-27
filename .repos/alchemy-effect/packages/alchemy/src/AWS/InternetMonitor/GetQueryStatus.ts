import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Monitor } from "./Monitor.ts";

export interface GetQueryStatusRequest extends Omit<
  im.GetQueryStatusInput,
  "MonitorName"
> {}

/**
 * Runtime binding for `internetmonitor:GetQueryStatus` — check whether a
 * query started on the bound {@link Monitor} is `QUEUED`, `RUNNING`,
 * `SUCCEEDED`, `FAILED`, or `CANCELED`; the monitor name is injected
 * automatically.
 *
 * Provide `InternetMonitor.GetQueryStatusHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Querying Measurements
 * @example Poll a Query Until It Completes
 * ```typescript
 * // init — grants internetmonitor:GetQueryStatus on the monitor
 * const getQueryStatus = yield* AWS.InternetMonitor.GetQueryStatus(monitor);
 *
 * // runtime
 * const { Status } = yield* getQueryStatus({ QueryId: queryId }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("2 seconds"),
 *     until: (r) => r.Status !== "QUEUED" && r.Status !== "RUNNING",
 *     times: 10,
 *   }),
 * );
 * ```
 */
export interface GetQueryStatus extends Binding.Service<
  GetQueryStatus,
  "AWS.InternetMonitor.GetQueryStatus",
  (
    monitor: Monitor,
  ) => Effect.Effect<
    (
      request: GetQueryStatusRequest,
    ) => Effect.Effect<im.GetQueryStatusOutput, im.GetQueryStatusError>
  >
> {}

export const GetQueryStatus = Binding.Service<GetQueryStatus>(
  "AWS.InternetMonitor.GetQueryStatus",
);

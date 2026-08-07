import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AnomalyMonitor } from "./AnomalyMonitor.ts";

/**
 * Request for {@link GetAnomalies} — the bound monitor's ARN is
 * injected automatically.
 */
export interface GetAnomaliesRequest extends Omit<
  ce.GetAnomaliesRequest,
  "MonitorArn"
> {}

/**
 * Runtime binding for `ce:GetAnomalies`.
 *
 * Retrieve the cost anomalies a monitor detected during a date
 * interval (available for up to 90 days). Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetAnomaliesHttp)`.
 * @binding
 * @section Anomaly Detection at Runtime
 * @example List a Monitor's Anomalies
 * ```typescript
 * // init — bind the operation to the monitor
 * const getAnomalies = yield* AWS.CostExplorer.GetAnomalies(monitor);
 *
 * // runtime
 * const result = yield* getAnomalies({
 *   DateInterval: { StartDate: "2026-06-01" },
 * });
 * const anomalies = result.Anomalies;
 * ```
 */
export interface GetAnomalies extends Binding.Service<
  GetAnomalies,
  "AWS.CostExplorer.GetAnomalies",
  (
    monitor: AnomalyMonitor,
  ) => Effect.Effect<
    (
      request: GetAnomaliesRequest,
    ) => Effect.Effect<ce.GetAnomaliesResponse, ce.GetAnomaliesError>
  >
> {}

export const GetAnomalies = Binding.Service<GetAnomalies>(
  "AWS.CostExplorer.GetAnomalies",
);

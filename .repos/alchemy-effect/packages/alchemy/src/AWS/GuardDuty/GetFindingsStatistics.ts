import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:GetFindingsStatistics`.
 *
 * Aggregates the detector's findings into statistics (grouped by severity, account, resource, or finding type) for dashboards and alert thresholds.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.GetFindingsStatisticsHttp)`.
 * @binding
 * @section Working with Findings
 * @example Count Findings by Severity
 * ```typescript
 * // init
 * const getFindingsStatistics = yield* AWS.GuardDuty.GetFindingsStatistics(detector);
 *
 * // runtime
 * const { FindingStatistics } = yield* getFindingsStatistics({
 *   GroupBy: "SEVERITY",
 * });
 * ```
 */
export interface GetFindingsStatistics extends Binding.Service<
  GetFindingsStatistics,
  "AWS.GuardDuty.GetFindingsStatistics",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.GetFindingsStatisticsRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.GetFindingsStatisticsResponse,
      guardduty.GetFindingsStatisticsError
    >
  >
> {}
export const GetFindingsStatistics = Binding.Service<GetFindingsStatistics>(
  "AWS.GuardDuty.GetFindingsStatistics",
);

import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:GetUsageStatistics`.
 *
 * Reports GuardDuty usage (cost) statistics for the detector, grouped by data source, feature, or member account.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.GetUsageStatisticsHttp)`.
 * @binding
 * @section Usage & Coverage
 * @example Usage by Data Source
 * ```typescript
 * // init
 * const getUsageStatistics = yield* AWS.GuardDuty.GetUsageStatistics(detector);
 *
 * // runtime
 * const { UsageStatistics } = yield* getUsageStatistics({
 *   UsageStatisticType: "SUM_BY_DATA_SOURCE",
 *   UsageCriteria: { DataSources: ["FLOW_LOGS"] },
 * });
 * ```
 */
export interface GetUsageStatistics extends Binding.Service<
  GetUsageStatistics,
  "AWS.GuardDuty.GetUsageStatistics",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.GetUsageStatisticsRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.GetUsageStatisticsResponse,
      guardduty.GetUsageStatisticsError
    >
  >
> {}
export const GetUsageStatistics = Binding.Service<GetUsageStatistics>(
  "AWS.GuardDuty.GetUsageStatistics",
);

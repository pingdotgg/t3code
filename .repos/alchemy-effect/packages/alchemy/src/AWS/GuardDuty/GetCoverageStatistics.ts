import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:GetCoverageStatistics`.
 *
 * Aggregates runtime-monitoring coverage counts (healthy vs unhealthy) for the detector's monitored resources.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.GetCoverageStatisticsHttp)`.
 * @binding
 * @section Usage & Coverage
 * @example Coverage by Resource Type
 * ```typescript
 * // init
 * const getCoverageStatistics = yield* AWS.GuardDuty.GetCoverageStatistics(detector);
 *
 * // runtime
 * const { CoverageStatistics } = yield* getCoverageStatistics({
 *   StatisticsType: ["COUNT_BY_RESOURCE_TYPE"],
 * });
 * ```
 */
export interface GetCoverageStatistics extends Binding.Service<
  GetCoverageStatistics,
  "AWS.GuardDuty.GetCoverageStatistics",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.GetCoverageStatisticsRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.GetCoverageStatisticsResponse,
      guardduty.GetCoverageStatisticsError
    >
  >
> {}
export const GetCoverageStatistics = Binding.Service<GetCoverageStatistics>(
  "AWS.GuardDuty.GetCoverageStatistics",
);

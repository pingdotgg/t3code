import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `GetFindingsStatistics` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface GetFindingsStatisticsRequest extends Omit<
  aa.GetFindingsStatisticsRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:GetFindingsStatistics`.
 *
 * Retrieves aggregate finding statistics for the analyzer (counts by resource
 * type or unused-access age). Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.GetFindingsStatisticsHttp)`.
 * @binding
 * @section Reading Findings
 * @example Get Finding Statistics
 * ```typescript
 * const getStatistics =
 *   yield* AWS.AccessAnalyzer.GetFindingsStatistics(analyzer);
 * const stats = yield* getStatistics();
 * ```
 */
export interface GetFindingsStatistics extends Binding.Service<
  GetFindingsStatistics,
  "AWS.AccessAnalyzer.GetFindingsStatistics",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request?: GetFindingsStatisticsRequest,
    ) => Effect.Effect<
      aa.GetFindingsStatisticsResponse,
      aa.GetFindingsStatisticsError
    >
  >
> {}

export const GetFindingsStatistics = Binding.Service<GetFindingsStatistics>(
  "AWS.AccessAnalyzer.GetFindingsStatistics",
);

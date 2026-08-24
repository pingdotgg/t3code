import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetFindingStatistics`.
 *
 * Retrieves (queries) aggregated statistical data about findings.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetFindingStatisticsHttp)`.
 * @binding
 * @section Working with Findings
 * @example Group Findings by Severity
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getFindingStatistics = yield* AWS.Macie2.GetFindingStatistics();
 *
 * // runtime
 * const { countsByGroup } = yield* getFindingStatistics({ groupBy: "severity.description" });
 * ```
 */
export interface GetFindingStatistics extends Binding.Service<
  GetFindingStatistics,
  "AWS.Macie2.GetFindingStatistics",
  () => Effect.Effect<
    (
      request?: macie2.GetFindingStatisticsRequest,
    ) => Effect.Effect<
      macie2.GetFindingStatisticsResponse,
      macie2.GetFindingStatisticsError
    >
  >
> {}
export const GetFindingStatistics = Binding.Service<GetFindingStatistics>(
  "AWS.Macie2.GetFindingStatistics",
);

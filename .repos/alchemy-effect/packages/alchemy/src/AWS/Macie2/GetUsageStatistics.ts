import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetUsageStatistics`.
 *
 * Retrieves (queries) quotas and aggregated usage data for one or more accounts.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetUsageStatisticsHttp)`.
 * @binding
 * @section Usage & Quotas
 * @example Per-Account Usage Statistics
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getUsageStatistics = yield* AWS.Macie2.GetUsageStatistics();
 *
 * // runtime
 * const { records } = yield* getUsageStatistics({});
 * ```
 */
export interface GetUsageStatistics extends Binding.Service<
  GetUsageStatistics,
  "AWS.Macie2.GetUsageStatistics",
  () => Effect.Effect<
    (
      request?: macie2.GetUsageStatisticsRequest,
    ) => Effect.Effect<
      macie2.GetUsageStatisticsResponse,
      macie2.GetUsageStatisticsError
    >
  >
> {}
export const GetUsageStatistics = Binding.Service<GetUsageStatistics>(
  "AWS.Macie2.GetUsageStatistics",
);

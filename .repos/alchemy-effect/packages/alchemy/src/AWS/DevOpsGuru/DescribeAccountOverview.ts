import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:DescribeAccountOverview`.
 *
 * Summarizes the insights created and the mean time to recover over a time range — the account's operational scorecard for a reporting window.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.DescribeAccountOverviewHttp)`.
 * @binding
 * @section Account Health
 * @example Summarize a Time Range
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeAccountOverview = yield* AWS.DevOpsGuru.DescribeAccountOverview();
 *
 * // runtime
 * const overview = yield* describeAccountOverview({
 *   FromTime: new Date(Date.now() - 7 * 24 * 3600_000),
 * });
 * yield* Effect.log(`MTTR: ${overview.MeanTimeToRecoverInMilliseconds}ms`);
 * ```
 */
export interface DescribeAccountOverview extends Binding.Service<
  DescribeAccountOverview,
  "AWS.DevOpsGuru.DescribeAccountOverview",
  () => Effect.Effect<
    (
      request: devopsguru.DescribeAccountOverviewRequest,
    ) => Effect.Effect<
      devopsguru.DescribeAccountOverviewResponse,
      devopsguru.DescribeAccountOverviewError
    >
  >
> {}
export const DescribeAccountOverview = Binding.Service<DescribeAccountOverview>(
  "AWS.DevOpsGuru.DescribeAccountOverview",
);

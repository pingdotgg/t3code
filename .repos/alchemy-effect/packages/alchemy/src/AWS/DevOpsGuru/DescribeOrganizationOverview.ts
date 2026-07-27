import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:DescribeOrganizationOverview`.
 *
 * Summarizes the insights created across the organization during a time range (management or delegated-administrator account).
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.DescribeOrganizationOverviewHttp)`.
 * @binding
 * @section Organization Visibility
 * @example Summarize the Organization over a Time Range
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeOrganizationOverview = yield* AWS.DevOpsGuru.DescribeOrganizationOverview();
 *
 * // runtime
 * const overview = yield* describeOrganizationOverview({
 *   FromTime: new Date(Date.now() - 7 * 24 * 3600_000),
 * });
 * yield* Effect.log(`reactive insights: ${overview.ReactiveInsights}`);
 * ```
 */
export interface DescribeOrganizationOverview extends Binding.Service<
  DescribeOrganizationOverview,
  "AWS.DevOpsGuru.DescribeOrganizationOverview",
  () => Effect.Effect<
    (
      request: devopsguru.DescribeOrganizationOverviewRequest,
    ) => Effect.Effect<
      devopsguru.DescribeOrganizationOverviewResponse,
      devopsguru.DescribeOrganizationOverviewError
    >
  >
> {}
export const DescribeOrganizationOverview =
  Binding.Service<DescribeOrganizationOverview>(
    "AWS.DevOpsGuru.DescribeOrganizationOverview",
  );

import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:DescribeOrganizationHealth`.
 *
 * Returns the number of open insights and analyzed resources across the organization (management or delegated-administrator account).
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.DescribeOrganizationHealthHttp)`.
 * @binding
 * @section Organization Visibility
 * @example Read Organization-Wide Insight Counts
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeOrganizationHealth = yield* AWS.DevOpsGuru.DescribeOrganizationHealth();
 *
 * // runtime
 * const health = yield* describeOrganizationHealth();
 * yield* Effect.log(`org open reactive: ${health.OpenReactiveInsights}`);
 * ```
 */
export interface DescribeOrganizationHealth extends Binding.Service<
  DescribeOrganizationHealth,
  "AWS.DevOpsGuru.DescribeOrganizationHealth",
  () => Effect.Effect<
    (
      request?: devopsguru.DescribeOrganizationHealthRequest,
    ) => Effect.Effect<
      devopsguru.DescribeOrganizationHealthResponse,
      devopsguru.DescribeOrganizationHealthError
    >
  >
> {}
export const DescribeOrganizationHealth =
  Binding.Service<DescribeOrganizationHealth>(
    "AWS.DevOpsGuru.DescribeOrganizationHealth",
  );

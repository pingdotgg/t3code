import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:DescribeAccountHealth`.
 *
 * Returns the number of open reactive and proactive insights, analyzed metrics, and resource hours for the account — the top line of an operations dashboard.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.DescribeAccountHealthHttp)`.
 * @binding
 * @section Account Health
 * @example Read Open Insight Counts
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeAccountHealth = yield* AWS.DevOpsGuru.DescribeAccountHealth();
 *
 * // runtime
 * const health = yield* describeAccountHealth();
 * yield* Effect.log(`open reactive insights: ${health.OpenReactiveInsights}`);
 * ```
 */
export interface DescribeAccountHealth extends Binding.Service<
  DescribeAccountHealth,
  "AWS.DevOpsGuru.DescribeAccountHealth",
  () => Effect.Effect<
    (
      request?: devopsguru.DescribeAccountHealthRequest,
    ) => Effect.Effect<
      devopsguru.DescribeAccountHealthResponse,
      devopsguru.DescribeAccountHealthError
    >
  >
> {}
export const DescribeAccountHealth = Binding.Service<DescribeAccountHealth>(
  "AWS.DevOpsGuru.DescribeAccountHealth",
);

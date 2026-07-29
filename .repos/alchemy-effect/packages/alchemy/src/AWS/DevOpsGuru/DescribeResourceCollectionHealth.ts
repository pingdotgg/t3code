import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:DescribeResourceCollectionHealth`.
 *
 * Returns the number of open insights per analyzed CloudFormation stack or app-boundary tag — where the operational pain is concentrated.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.DescribeResourceCollectionHealthHttp)`.
 * @binding
 * @section Coverage Health
 * @example Read Per-Stack Health
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeResourceCollectionHealth = yield* AWS.DevOpsGuru.DescribeResourceCollectionHealth();
 *
 * // runtime
 * const page = yield* describeResourceCollectionHealth({
 *   ResourceCollectionType: "AWS_CLOUD_FORMATION",
 * });
 * for (const stack of page.CloudFormation ?? []) {
 *   yield* Effect.log(`${stack.StackName}: ${stack.Insight?.OpenReactiveInsights}`);
 * }
 * ```
 */
export interface DescribeResourceCollectionHealth extends Binding.Service<
  DescribeResourceCollectionHealth,
  "AWS.DevOpsGuru.DescribeResourceCollectionHealth",
  () => Effect.Effect<
    (
      request: devopsguru.DescribeResourceCollectionHealthRequest,
    ) => Effect.Effect<
      devopsguru.DescribeResourceCollectionHealthResponse,
      devopsguru.DescribeResourceCollectionHealthError
    >
  >
> {}
export const DescribeResourceCollectionHealth =
  Binding.Service<DescribeResourceCollectionHealth>(
    "AWS.DevOpsGuru.DescribeResourceCollectionHealth",
  );

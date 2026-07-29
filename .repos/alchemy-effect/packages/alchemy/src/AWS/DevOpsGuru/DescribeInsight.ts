import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:DescribeInsight`.
 *
 * Returns the details of a single insight — severity, status, time ranges, and the SSM OpsItem id when OpsCenter integration is enabled. The building block of an incident-response Function reacting to DevOps Guru notifications.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.DescribeInsightHttp)`.
 * @binding
 * @section Inspecting Insights
 * @example Read an Insight's Detail
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeInsight = yield* AWS.DevOpsGuru.DescribeInsight();
 *
 * // runtime
 * const { ReactiveInsight } = yield* describeInsight({ Id: insightId });
 * yield* Effect.log(`${ReactiveInsight?.Severity}: ${ReactiveInsight?.Name}`);
 * ```
 */
export interface DescribeInsight extends Binding.Service<
  DescribeInsight,
  "AWS.DevOpsGuru.DescribeInsight",
  () => Effect.Effect<
    (
      request: devopsguru.DescribeInsightRequest,
    ) => Effect.Effect<
      devopsguru.DescribeInsightResponse,
      devopsguru.DescribeInsightError
    >
  >
> {}
export const DescribeInsight = Binding.Service<DescribeInsight>(
  "AWS.DevOpsGuru.DescribeInsight",
);

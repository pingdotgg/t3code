import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:DescribeAnomaly`.
 *
 * Returns the details of a single anomaly — severity, status, time ranges, and the CloudWatch/Performance Insights metrics that triggered it.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.DescribeAnomalyHttp)`.
 * @binding
 * @section Inspecting Anomalies
 * @example Read an Anomaly's Detail
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeAnomaly = yield* AWS.DevOpsGuru.DescribeAnomaly();
 *
 * // runtime
 * const { ReactiveAnomaly } = yield* describeAnomaly({ Id: anomalyId });
 * yield* Effect.log(`severity: ${ReactiveAnomaly?.Severity}`);
 * ```
 */
export interface DescribeAnomaly extends Binding.Service<
  DescribeAnomaly,
  "AWS.DevOpsGuru.DescribeAnomaly",
  () => Effect.Effect<
    (
      request: devopsguru.DescribeAnomalyRequest,
    ) => Effect.Effect<
      devopsguru.DescribeAnomalyResponse,
      devopsguru.DescribeAnomalyError
    >
  >
> {}
export const DescribeAnomaly = Binding.Service<DescribeAnomaly>(
  "AWS.DevOpsGuru.DescribeAnomaly",
);

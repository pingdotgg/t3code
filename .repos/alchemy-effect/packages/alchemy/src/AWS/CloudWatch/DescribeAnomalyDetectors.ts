import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeAnomalyDetectorsRequest
  extends cloudwatch.DescribeAnomalyDetectorsInput {}

/**
 * Runtime binding for `cloudwatch:DescribeAnomalyDetectors` — list the
 * anomaly detection models in the account/region, optionally filtered by
 * namespace, metric name, or dimensions.
 *
 * Provide `CloudWatch.DescribeAnomalyDetectorsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Anomaly Detectors
 * @example List Detectors in a Namespace
 * ```typescript
 * // init — grants cloudwatch:DescribeAnomalyDetectors
 * const describeAnomalyDetectors = yield* AWS.CloudWatch.DescribeAnomalyDetectors();
 *
 * // runtime
 * const result = yield* describeAnomalyDetectors({
 *   Namespace: "MyApp/Payments",
 * });
 * const detectors = result.AnomalyDetectors ?? [];
 * ```
 */
export interface DescribeAnomalyDetectors extends Binding.Service<
  DescribeAnomalyDetectors,
  "AWS.CloudWatch.DescribeAnomalyDetectors",
  () => Effect.Effect<
    (
      request?: DescribeAnomalyDetectorsRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeAnomalyDetectorsOutput,
      cloudwatch.DescribeAnomalyDetectorsError
    >
  >
> {}

export const DescribeAnomalyDetectors =
  Binding.Service<DescribeAnomalyDetectors>(
    "AWS.CloudWatch.DescribeAnomalyDetectors",
  );

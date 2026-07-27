import type * as cloudformation from "@distilled.cloud/aws/cloudformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeStackDriftDetectionStatus` operation (IAM
 * action `cloudformation:DescribeStackDriftDetectionStatus` on `*` — the
 * detection id is not resource-scoped).
 *
 * Polls a drift-detection run started with {@link DetectStackDrift} until it
 * reaches `DETECTION_COMPLETE` / `DETECTION_FAILED` and reports the stack's
 * overall drift status. Provide the implementation with
 * `Effect.provide(AWS.CloudFormation.DescribeStackDriftDetectionStatusHttp)`.
 * @binding
 * @section Drift Detection
 * @example Poll a Drift Detection Run
 * ```typescript
 * const describeStackDriftDetectionStatus =
 *   yield* AWS.CloudFormation.DescribeStackDriftDetectionStatus();
 *
 * const status = yield* describeStackDriftDetectionStatus({
 *   StackDriftDetectionId: detectionId,
 * });
 * // status.DetectionStatus, status.StackDriftStatus
 * ```
 */
export interface DescribeStackDriftDetectionStatus extends Binding.Service<
  DescribeStackDriftDetectionStatus,
  "AWS.CloudFormation.DescribeStackDriftDetectionStatus",
  () => Effect.Effect<
    (
      request: cloudformation.DescribeStackDriftDetectionStatusInput,
    ) => Effect.Effect<
      cloudformation.DescribeStackDriftDetectionStatusOutput,
      cloudformation.DescribeStackDriftDetectionStatusError
    >
  >
> {}
export const DescribeStackDriftDetectionStatus =
  Binding.Service<DescribeStackDriftDetectionStatus>(
    "AWS.CloudFormation.DescribeStackDriftDetectionStatus",
  );

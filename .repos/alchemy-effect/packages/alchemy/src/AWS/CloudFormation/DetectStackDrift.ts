import type * as cloudformation from "@distilled.cloud/aws/cloudformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stack } from "./Stack.ts";

/**
 * Runtime binding for the `DetectStackDrift` operation (IAM actions
 * `cloudformation:DetectStackDrift` + `cloudformation:DetectStackResourceDrift`
 * — AWS authorizes both on the per-stack call).
 *
 * Bind this operation to a {@link Stack} to start drift detection from inside
 * a function runtime — e.g. a scheduled drift monitor. Detection runs
 * asynchronously; poll the returned `StackDriftDetectionId` with
 * {@link DescribeStackDriftDetectionStatus}. Note that CloudFormation reads
 * the live state of the stack's resources with the caller's credentials, so
 * the function also needs read access to the resource types in the template
 * for the detection to complete. Provide the implementation with
 * `Effect.provide(AWS.CloudFormation.DetectStackDriftHttp)`.
 * @binding
 * @section Drift Detection
 * @example Start Drift Detection
 * ```typescript
 * const detectStackDrift = yield* AWS.CloudFormation.DetectStackDrift(stack);
 *
 * const { StackDriftDetectionId } = yield* detectStackDrift();
 * ```
 */
export interface DetectStackDrift extends Binding.Service<
  DetectStackDrift,
  "AWS.CloudFormation.DetectStackDrift",
  (
    stack: Stack,
  ) => Effect.Effect<
    (
      request?: Omit<cloudformation.DetectStackDriftInput, "StackName">,
    ) => Effect.Effect<
      cloudformation.DetectStackDriftOutput,
      cloudformation.DetectStackDriftError
    >
  >
> {}
export const DetectStackDrift = Binding.Service<DetectStackDrift>(
  "AWS.CloudFormation.DetectStackDrift",
);

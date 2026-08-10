import type * as cloudformation from "@distilled.cloud/aws/cloudformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stack } from "./Stack.ts";

/**
 * Runtime binding for the `DescribeStackResourceDrifts` operation (IAM action
 * `cloudformation:DescribeStackResourceDrifts`).
 *
 * Bind this operation to a {@link Stack} to read per-resource drift results
 * after a {@link DetectStackDrift} run — which resources were `MODIFIED` or
 * `DELETED` out-of-band and the actual-vs-expected property differences.
 * Provide the implementation with
 * `Effect.provide(AWS.CloudFormation.DescribeStackResourceDriftsHttp)`.
 * @binding
 * @section Drift Detection
 * @example Read Drifted Resources
 * ```typescript
 * const describeStackResourceDrifts =
 *   yield* AWS.CloudFormation.DescribeStackResourceDrifts(stack);
 *
 * const { StackResourceDrifts } = yield* describeStackResourceDrifts({
 *   StackResourceDriftStatusFilters: ["MODIFIED", "DELETED"],
 * });
 * ```
 */
export interface DescribeStackResourceDrifts extends Binding.Service<
  DescribeStackResourceDrifts,
  "AWS.CloudFormation.DescribeStackResourceDrifts",
  (
    stack: Stack,
  ) => Effect.Effect<
    (
      request?: Omit<
        cloudformation.DescribeStackResourceDriftsInput,
        "StackName"
      >,
    ) => Effect.Effect<
      cloudformation.DescribeStackResourceDriftsOutput,
      cloudformation.DescribeStackResourceDriftsError
    >
  >
> {}
export const DescribeStackResourceDrifts =
  Binding.Service<DescribeStackResourceDrifts>(
    "AWS.CloudFormation.DescribeStackResourceDrifts",
  );

import type * as cloudformation from "@distilled.cloud/aws/cloudformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stack } from "./Stack.ts";

/**
 * Runtime binding for the `DescribeStackResources` operation (IAM action
 * `cloudformation:DescribeStackResources`).
 *
 * Bind this operation to a {@link Stack} to resolve the physical ids of the
 * stack's resources — e.g. look up a resource created by the template by its
 * logical id from inside a function runtime. Provide the implementation with
 * `Effect.provide(AWS.CloudFormation.DescribeStackResourcesHttp)`.
 * @binding
 * @section Reading Stack Resources
 * @example Resolve a Resource's Physical Id
 * ```typescript
 * const describeStackResources =
 *   yield* AWS.CloudFormation.DescribeStackResources(stack);
 *
 * const { StackResources } = yield* describeStackResources({
 *   LogicalResourceId: "Param",
 * });
 * const physicalId = StackResources?.[0]?.PhysicalResourceId;
 * ```
 */
export interface DescribeStackResources extends Binding.Service<
  DescribeStackResources,
  "AWS.CloudFormation.DescribeStackResources",
  (
    stack: Stack,
  ) => Effect.Effect<
    (
      request?: Omit<cloudformation.DescribeStackResourcesInput, "StackName">,
    ) => Effect.Effect<
      cloudformation.DescribeStackResourcesOutput,
      cloudformation.DescribeStackResourcesError
    >
  >
> {}
export const DescribeStackResources = Binding.Service<DescribeStackResources>(
  "AWS.CloudFormation.DescribeStackResources",
);

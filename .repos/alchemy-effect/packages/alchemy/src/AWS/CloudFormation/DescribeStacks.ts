import type * as cloudformation from "@distilled.cloud/aws/cloudformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stack } from "./Stack.ts";

/**
 * Runtime binding for the `DescribeStacks` operation (IAM action
 * `cloudformation:DescribeStacks`).
 *
 * Bind this operation to a {@link Stack} to read its live status, parameters,
 * and template outputs from inside a function runtime — the classic
 * service-discovery pattern of resolving endpoints/ARNs from a stack's
 * outputs. Provide the implementation with
 * `Effect.provide(AWS.CloudFormation.DescribeStacksHttp)`.
 * @binding
 * @section Reading Stacks
 * @example Read a Stack's Outputs
 * ```typescript
 * // init — bind the operation to the stack
 * const describeStacks = yield* AWS.CloudFormation.DescribeStacks(stack);
 *
 * // runtime
 * const { Stacks } = yield* describeStacks();
 * const outputs = Stacks?.[0]?.Outputs ?? [];
 * ```
 */
export interface DescribeStacks extends Binding.Service<
  DescribeStacks,
  "AWS.CloudFormation.DescribeStacks",
  (
    stack: Stack,
  ) => Effect.Effect<
    (
      request?: Omit<cloudformation.DescribeStacksInput, "StackName">,
    ) => Effect.Effect<
      cloudformation.DescribeStacksOutput,
      cloudformation.DescribeStacksError
    >
  >
> {}
export const DescribeStacks = Binding.Service<DescribeStacks>(
  "AWS.CloudFormation.DescribeStacks",
);

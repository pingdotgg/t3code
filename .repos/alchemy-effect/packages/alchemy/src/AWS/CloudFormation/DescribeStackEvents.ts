import type * as cloudformation from "@distilled.cloud/aws/cloudformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stack } from "./Stack.ts";

/**
 * Runtime binding for the `DescribeStackEvents` operation (IAM action
 * `cloudformation:DescribeStackEvents`).
 *
 * Bind this operation to a {@link Stack} to read its event history —
 * per-resource create/update/delete progress and failure reasons — from
 * inside a function runtime. Useful for deployment dashboards and failure
 * alerting. Provide the implementation with
 * `Effect.provide(AWS.CloudFormation.DescribeStackEventsHttp)`.
 * @binding
 * @section Reading Stacks
 * @example Read Recent Stack Events
 * ```typescript
 * const describeStackEvents =
 *   yield* AWS.CloudFormation.DescribeStackEvents(stack);
 *
 * const { StackEvents } = yield* describeStackEvents();
 * const failures = (StackEvents ?? []).filter(
 *   (e) => e.ResourceStatus?.endsWith("_FAILED"),
 * );
 * ```
 */
export interface DescribeStackEvents extends Binding.Service<
  DescribeStackEvents,
  "AWS.CloudFormation.DescribeStackEvents",
  (
    stack: Stack,
  ) => Effect.Effect<
    (
      request?: Omit<cloudformation.DescribeStackEventsInput, "StackName">,
    ) => Effect.Effect<
      cloudformation.DescribeStackEventsOutput,
      cloudformation.DescribeStackEventsError
    >
  >
> {}
export const DescribeStackEvents = Binding.Service<DescribeStackEvents>(
  "AWS.CloudFormation.DescribeStackEvents",
);

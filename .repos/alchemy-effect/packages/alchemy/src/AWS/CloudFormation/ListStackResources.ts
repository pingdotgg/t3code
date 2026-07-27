import type * as cloudformation from "@distilled.cloud/aws/cloudformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stack } from "./Stack.ts";

/**
 * Runtime binding for the `ListStackResources` operation (IAM action
 * `cloudformation:ListStackResources`).
 *
 * Bind this operation to a {@link Stack} to enumerate all of the stack's
 * resource summaries (paginated) from inside a function runtime — the
 * lighter-weight alternative to `DescribeStackResources` for stacks with many
 * resources. Provide the implementation with
 * `Effect.provide(AWS.CloudFormation.ListStackResourcesHttp)`.
 * @binding
 * @section Reading Stack Resources
 * @example Enumerate Stack Resources
 * ```typescript
 * const listStackResources =
 *   yield* AWS.CloudFormation.ListStackResources(stack);
 *
 * const { StackResourceSummaries } = yield* listStackResources();
 * const types = (StackResourceSummaries ?? []).map((r) => r.ResourceType);
 * ```
 */
export interface ListStackResources extends Binding.Service<
  ListStackResources,
  "AWS.CloudFormation.ListStackResources",
  (
    stack: Stack,
  ) => Effect.Effect<
    (
      request?: Omit<cloudformation.ListStackResourcesInput, "StackName">,
    ) => Effect.Effect<
      cloudformation.ListStackResourcesOutput,
      cloudformation.ListStackResourcesError
    >
  >
> {}
export const ListStackResources = Binding.Service<ListStackResources>(
  "AWS.CloudFormation.ListStackResources",
);

import type * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Group } from "./Group.ts";

/** Request for {@link UngroupResources} — the group is injected from the binding. */
export type UngroupResourcesRequest = Omit<
  resourcegroups.UngroupResourcesInput,
  "Group"
>;

/**
 * Runtime binding for `resource-groups:UngroupResources`.
 *
 * Removes the specified resources from the bound {@link Group} (the inverse
 * of {@link GroupResources} — supported for the same application /
 * host-management / capacity-reservation-pool group types). Ungrouping is
 * asynchronous; track the reported `Pending` ARNs with
 * {@link ListGroupingStatuses}. The group name is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.ResourceGroups.UngroupResourcesHttp)`.
 * @binding
 * @section Managing Group Membership
 * @example Remove A Resource From An Application Group
 * ```typescript
 * // init — bind the operation to the group
 * const ungroupResources = yield* AWS.ResourceGroups.UngroupResources(group);
 *
 * // runtime
 * const { Succeeded, Pending } = yield* ungroupResources({
 *   ResourceArns: [resourceArn],
 * });
 * ```
 */
export interface UngroupResources extends Binding.Service<
  UngroupResources,
  "AWS.ResourceGroups.UngroupResources",
  (
    group: Group,
  ) => Effect.Effect<
    (
      request: UngroupResourcesRequest,
    ) => Effect.Effect<
      resourcegroups.UngroupResourcesOutput,
      resourcegroups.UngroupResourcesError
    >
  >
> {}
export const UngroupResources = Binding.Service<UngroupResources>(
  "AWS.ResourceGroups.UngroupResources",
);

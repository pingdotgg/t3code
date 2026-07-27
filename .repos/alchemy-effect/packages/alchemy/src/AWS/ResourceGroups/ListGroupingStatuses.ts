import type * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Group } from "./Group.ts";

/** Request for {@link ListGroupingStatuses} — the group is injected from the binding. */
export type ListGroupingStatusesRequest = Omit<
  resourcegroups.ListGroupingStatusesInput,
  "Group"
>;

/**
 * Runtime binding for `resource-groups:ListGroupingStatuses`.
 *
 * Returns the status of the last grouping or ungrouping action for each
 * resource in the bound application {@link Group} — grouping members is
 * asynchronous, so this is how a function tracks a `GroupResources` /
 * `UngroupResources` request to `SUCCESS` or reads the failure reason. The
 * group name is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.ResourceGroups.ListGroupingStatusesHttp)`.
 * @binding
 * @section Enumerating Group Members
 * @example Track A Pending Grouping Action
 * ```typescript
 * // init — bind the operation to the group
 * const listGroupingStatuses = yield* AWS.ResourceGroups.ListGroupingStatuses(group);
 *
 * // runtime
 * const { GroupingStatuses } = yield* listGroupingStatuses();
 * const failed = (GroupingStatuses ?? []).filter((s) => s.Status === "FAILED");
 * ```
 */
export interface ListGroupingStatuses extends Binding.Service<
  ListGroupingStatuses,
  "AWS.ResourceGroups.ListGroupingStatuses",
  (
    group: Group,
  ) => Effect.Effect<
    (
      request?: ListGroupingStatusesRequest,
    ) => Effect.Effect<
      resourcegroups.ListGroupingStatusesOutput,
      resourcegroups.ListGroupingStatusesError
    >
  >
> {}
export const ListGroupingStatuses = Binding.Service<ListGroupingStatuses>(
  "AWS.ResourceGroups.ListGroupingStatuses",
);

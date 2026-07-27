import type * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Group } from "./Group.ts";

/** Request for {@link GroupResources} — the group is injected from the binding. */
export type GroupResourcesRequest = Omit<
  resourcegroups.GroupResourcesInput,
  "Group"
>;

/**
 * Runtime binding for `resource-groups:GroupResources`.
 *
 * Adds the specified resources to the bound {@link Group}. Supported only
 * for groups configured with `AWS::ResourceGroups::ApplicationGroup`,
 * `AWS::EC2::HostManagement`, or `AWS::EC2::CapacityReservationPool` —
 * query-based groups derive membership from their query instead. Grouping
 * is asynchronous (application-group members are tagged with
 * `awsApplication`): the response reports `Pending` ARNs which
 * {@link ListGroupingStatuses} tracks to `SUCCESS`/`FAILED`. The group name
 * is injected from the binding; the grant includes the Tagging API
 * permissions the membership tagging fans out to (member services may
 * additionally require their own `TagResource` permission on the caller).
 * Provide the implementation with
 * `Effect.provide(AWS.ResourceGroups.GroupResourcesHttp)`.
 * @binding
 * @section Managing Group Membership
 * @example Add A Resource To An Application Group
 * ```typescript
 * // init — bind the operation to the group
 * const groupResources = yield* AWS.ResourceGroups.GroupResources(group);
 *
 * // runtime
 * const { Succeeded, Pending, Failed } = yield* groupResources({
 *   ResourceArns: [resourceArn],
 * });
 * ```
 */
export interface GroupResources extends Binding.Service<
  GroupResources,
  "AWS.ResourceGroups.GroupResources",
  (
    group: Group,
  ) => Effect.Effect<
    (
      request: GroupResourcesRequest,
    ) => Effect.Effect<
      resourcegroups.GroupResourcesOutput,
      resourcegroups.GroupResourcesError
    >
  >
> {}
export const GroupResources = Binding.Service<GroupResources>(
  "AWS.ResourceGroups.GroupResources",
);

import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `DescribeGroupMembership` operation (IAM action
 * `identitystore:DescribeGroupMembership`), scoped to one {@link Instance}.
 *
 * Reads a group membership (group id + member id) from the bound instance's identity store by `MembershipId`. The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.DescribeGroupMembershipHttp)`.
 * @binding
 * @section Querying Group Memberships
 * @example Read a Membership
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const describeGroupMembership = yield* AWS.IdentityCenter.DescribeGroupMembership(instance);
 *
 * // runtime
 * const membership = yield* describeGroupMembership({
 *   MembershipId: membershipId,
 * });
 * console.log(membership.GroupId, membership.MemberId);
 * ```
 */
export interface DescribeGroupMembership extends Binding.Service<
  DescribeGroupMembership,
  "AWS.IdentityCenter.DescribeGroupMembership",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<
        identitystore.DescribeGroupMembershipRequest,
        "IdentityStoreId"
      >,
    ) => Effect.Effect<
      identitystore.DescribeGroupMembershipResponse,
      identitystore.DescribeGroupMembershipError
    >
  >
> {}
export const DescribeGroupMembership = Binding.Service<DescribeGroupMembership>(
  "AWS.IdentityCenter.DescribeGroupMembership",
);

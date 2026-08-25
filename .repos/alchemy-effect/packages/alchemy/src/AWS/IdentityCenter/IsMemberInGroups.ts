import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `IsMemberInGroups` operation (IAM action
 * `identitystore:IsMemberInGroups`), scoped to one {@link Instance}.
 *
 * Checks whether a user belongs to any of up to 100 groups in one call — the fast authorization primitive for group-gated routes. The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.IsMemberInGroupsHttp)`.
 * @binding
 * @section Querying Group Memberships
 * @example Gate a Route on Group Membership
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const isMemberInGroups = yield* AWS.IdentityCenter.IsMemberInGroups(instance);
 *
 * // runtime
 * const { Results } = yield* isMemberInGroups({
 *   MemberId: { UserId: userId },
 *   GroupIds: [adminGroupId],
 * });
 * const isAdmin = Results?.[0]?.MembershipExists === true;
 * ```
 */
export interface IsMemberInGroups extends Binding.Service<
  IsMemberInGroups,
  "AWS.IdentityCenter.IsMemberInGroups",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<identitystore.IsMemberInGroupsRequest, "IdentityStoreId">,
    ) => Effect.Effect<
      identitystore.IsMemberInGroupsResponse,
      identitystore.IsMemberInGroupsError
    >
  >
> {}
export const IsMemberInGroups = Binding.Service<IsMemberInGroups>(
  "AWS.IdentityCenter.IsMemberInGroups",
);

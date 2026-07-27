import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `GetGroupMembershipId` operation (IAM action
 * `identitystore:GetGroupMembershipId`), scoped to one {@link Instance}.
 *
 * Resolves the `MembershipId` linking a user to a group in the bound instance's identity store. The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.GetGroupMembershipIdHttp)`.
 * @binding
 * @section Querying Group Memberships
 * @example Resolve a MembershipId
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const getGroupMembershipId = yield* AWS.IdentityCenter.GetGroupMembershipId(instance);
 *
 * // runtime
 * const { MembershipId } = yield* getGroupMembershipId({
 *   GroupId: groupId,
 *   MemberId: { UserId: userId },
 * });
 * ```
 */
export interface GetGroupMembershipId extends Binding.Service<
  GetGroupMembershipId,
  "AWS.IdentityCenter.GetGroupMembershipId",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<
        identitystore.GetGroupMembershipIdRequest,
        "IdentityStoreId"
      >,
    ) => Effect.Effect<
      identitystore.GetGroupMembershipIdResponse,
      identitystore.GetGroupMembershipIdError
    >
  >
> {}
export const GetGroupMembershipId = Binding.Service<GetGroupMembershipId>(
  "AWS.IdentityCenter.GetGroupMembershipId",
);

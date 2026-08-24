import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:InviteMembers`.
 *
 * Invites the specified accounts to associate with this account as Security Hub members.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.InviteMembersHttp)`.
 * @binding
 * @section Members & Organization
 * @example Invite Members
 * ```typescript
 * // init — account-level binding, no resource argument
 * const inviteMembers = yield* AWS.SecurityHub.InviteMembers();
 *
 * // runtime
 * yield* inviteMembers({ AccountIds: ["111122223333"] });
 * ```
 */
export interface InviteMembers extends Binding.Service<
  InviteMembers,
  "AWS.SecurityHub.InviteMembers",
  () => Effect.Effect<
    (
      request?: securityhub.InviteMembersRequest,
    ) => Effect.Effect<
      securityhub.InviteMembersResponse,
      securityhub.InviteMembersError
    >
  >
> {}
export const InviteMembers = Binding.Service<InviteMembers>(
  "AWS.SecurityHub.InviteMembers",
);

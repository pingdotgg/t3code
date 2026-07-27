import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:InviteAccountToOrganization`.
 *
 * Sends an invitation (handshake) to another account to join the organization as a member account.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.InviteAccountToOrganizationHttp)`.
 * @binding
 * @section Handshakes & Invitations
 * @example Invite an Account
 * ```typescript
 * // init — account-level binding, no resource argument
 * const inviteAccountToOrganization = yield* AWS.Organizations.InviteAccountToOrganization();
 *
 * // runtime
 * const { Handshake } = yield* inviteAccountToOrganization({
 *   Target: { Id: "111122223333", Type: "ACCOUNT" },
 * });
 * ```
 */
export interface InviteAccountToOrganization extends Binding.Service<
  InviteAccountToOrganization,
  "AWS.Organizations.InviteAccountToOrganization",
  () => Effect.Effect<
    (
      request: organizations.InviteAccountToOrganizationRequest,
    ) => Effect.Effect<
      organizations.InviteAccountToOrganizationResponse,
      organizations.InviteAccountToOrganizationError
    >
  >
> {}
export const InviteAccountToOrganization =
  Binding.Service<InviteAccountToOrganization>(
    "AWS.Organizations.InviteAccountToOrganization",
  );

import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:AcceptAdministratorInvitation`.
 *
 * Accepts an invitation to become a member of a Security Hub administrator account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.AcceptAdministratorInvitationHttp)`.
 * @binding
 * @section Members & Organization
 * @example Accept an Administrator Invitation
 * ```typescript
 * // init — account-level binding, no resource argument
 * const acceptAdministratorInvitation = yield* AWS.SecurityHub.AcceptAdministratorInvitation();
 *
 * // runtime
 * yield* acceptAdministratorInvitation({
 *   AdministratorId: adminAccountId,
 *   InvitationId: invitationId,
 * });
 * ```
 */
export interface AcceptAdministratorInvitation extends Binding.Service<
  AcceptAdministratorInvitation,
  "AWS.SecurityHub.AcceptAdministratorInvitation",
  () => Effect.Effect<
    (
      request?: securityhub.AcceptAdministratorInvitationRequest,
    ) => Effect.Effect<
      securityhub.AcceptAdministratorInvitationResponse,
      securityhub.AcceptAdministratorInvitationError
    >
  >
> {}
export const AcceptAdministratorInvitation =
  Binding.Service<AcceptAdministratorInvitation>(
    "AWS.SecurityHub.AcceptAdministratorInvitation",
  );

import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:DeleteInvitations`.
 *
 * Deletes Security Hub membership invitations from the specified accounts.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.DeleteInvitationsHttp)`.
 * @binding
 * @section Members & Organization
 * @example Delete Invitations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const deleteInvitations = yield* AWS.SecurityHub.DeleteInvitations();
 *
 * // runtime
 * yield* deleteInvitations({ AccountIds: ["111122223333"] });
 * ```
 */
export interface DeleteInvitations extends Binding.Service<
  DeleteInvitations,
  "AWS.SecurityHub.DeleteInvitations",
  () => Effect.Effect<
    (
      request?: securityhub.DeleteInvitationsRequest,
    ) => Effect.Effect<
      securityhub.DeleteInvitationsResponse,
      securityhub.DeleteInvitationsError
    >
  >
> {}
export const DeleteInvitations = Binding.Service<DeleteInvitations>(
  "AWS.SecurityHub.DeleteInvitations",
);

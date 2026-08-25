import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `guardduty:DeleteInvitations`.
 *
 * Deletes received membership invitations from the given administrator account ids.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.DeleteInvitationsHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example Delete Invitations
 * ```typescript
 * // init
 * // init — account-level binding, no resource argument
 * const deleteInvitations = yield* AWS.GuardDuty.DeleteInvitations();
 *
 * // runtime
 * yield* deleteInvitations({ AccountIds: ["111122223333"] });
 * ```
 */
export interface DeleteInvitations extends Binding.Service<
  DeleteInvitations,
  "AWS.GuardDuty.DeleteInvitations",
  () => Effect.Effect<
    (
      request?: guardduty.DeleteInvitationsRequest,
    ) => Effect.Effect<
      guardduty.DeleteInvitationsResponse,
      guardduty.DeleteInvitationsError
    >
  >
> {}
export const DeleteInvitations = Binding.Service<DeleteInvitations>(
  "AWS.GuardDuty.DeleteInvitations",
);

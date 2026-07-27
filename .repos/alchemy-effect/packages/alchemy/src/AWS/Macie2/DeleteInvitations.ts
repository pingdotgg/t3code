import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:DeleteInvitations`.
 *
 * Deletes Amazon Macie membership invitations that were received from specific accounts.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.DeleteInvitationsHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example Delete Received Invitations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const deleteInvitations = yield* AWS.Macie2.DeleteInvitations();
 *
 * // runtime
 * yield* deleteInvitations({ accountIds });
 * ```
 */
export interface DeleteInvitations extends Binding.Service<
  DeleteInvitations,
  "AWS.Macie2.DeleteInvitations",
  () => Effect.Effect<
    (
      request?: macie2.DeleteInvitationsRequest,
    ) => Effect.Effect<
      macie2.DeleteInvitationsResponse,
      macie2.DeleteInvitationsError
    >
  >
> {}
export const DeleteInvitations = Binding.Service<DeleteInvitations>(
  "AWS.Macie2.DeleteInvitations",
);

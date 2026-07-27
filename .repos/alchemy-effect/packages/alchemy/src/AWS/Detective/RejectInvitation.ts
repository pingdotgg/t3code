import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `detective:RejectInvitation`.
 *
 * Rejects an open invitation into an administrator account's behavior
 * graph — the decline path of the member-account invitation flow.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.RejectInvitationHttp)`.
 * @binding
 * @section Responding to Invitations
 * @example Decline An Invitation
 * ```typescript
 * // init — account-level binding, no resource argument
 * const rejectInvitation = yield* AWS.Detective.RejectInvitation();
 *
 * // runtime
 * yield* rejectInvitation({ GraphArn: invitation.GraphArn! });
 * ```
 */
export interface RejectInvitation extends Binding.Service<
  RejectInvitation,
  "AWS.Detective.RejectInvitation",
  () => Effect.Effect<
    (
      request: detective.RejectInvitationRequest,
    ) => Effect.Effect<
      detective.RejectInvitationResponse,
      detective.RejectInvitationError
    >
  >
> {}
export const RejectInvitation = Binding.Service<RejectInvitation>(
  "AWS.Detective.RejectInvitation",
);

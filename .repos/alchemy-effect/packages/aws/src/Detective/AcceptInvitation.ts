import type * as detective from "@distilled.cloud/aws/detective";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `detective:AcceptInvitation`.
 *
 * Accepts an invitation into an administrator account's behavior graph —
 * the graph belongs to the admin account, so its ARN arrives at runtime
 * (typically from `ListInvitations`) rather than from a bound resource.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.AcceptInvitationHttp)`.
 * ### Responding to Invitations
 * **Example:** Auto-Accept An Invitation
 * ```typescript
 * // init — account-level binding, no resource argument
 * const acceptInvitation = yield* AWS.Detective.AcceptInvitation();
 *
 * // runtime
 * yield* acceptInvitation({ GraphArn: invitation.GraphArn! });
 * ```
 *
 * @binding
 */
export interface AcceptInvitation extends Binding.Service<
  AcceptInvitation,
  "AWS.Detective.AcceptInvitation",
  () => Effect.Effect<
    (
      request: detective.AcceptInvitationRequest,
    ) => Effect.Effect<detective.AcceptInvitationResponse, detective.AcceptInvitationError>
  >
> {}
export const AcceptInvitation = Binding.Service<AcceptInvitation>("AWS.Detective.AcceptInvitation");

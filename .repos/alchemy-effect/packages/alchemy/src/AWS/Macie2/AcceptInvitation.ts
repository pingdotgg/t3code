import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:AcceptInvitation`.
 *
 * Accepts an Amazon Macie membership invitation that was received from a specific account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.AcceptInvitationHttp)`.
 * ### Administrator & Invitations
 * **Example:** Accept an Administrator's Invitation
 * ```typescript
 * // init — account-level binding, no resource argument
 * const acceptInvitation = yield* AWS.Macie2.AcceptInvitation();
 *
 * // runtime
 * yield* acceptInvitation({ administratorAccountId, invitationId });
 * ```
 *
 * @binding
 */
export interface AcceptInvitation extends Binding.Service<
  AcceptInvitation,
  "AWS.Macie2.AcceptInvitation",
  () => Effect.Effect<
    (
      request?: macie2.AcceptInvitationRequest,
    ) => Effect.Effect<
      macie2.AcceptInvitationResponse,
      macie2.AcceptInvitationError
    >
  >
> {}
export const AcceptInvitation = Binding.Service<AcceptInvitation>(
  "AWS.Macie2.AcceptInvitation",
);

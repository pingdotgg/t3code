import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:DeclineInvitations`.
 *
 * Declines Amazon Macie membership invitations that were received from specific accounts.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.DeclineInvitationsHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example Decline Invitations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const declineInvitations = yield* AWS.Macie2.DeclineInvitations();
 *
 * // runtime
 * yield* declineInvitations({ accountIds });
 * ```
 */
export interface DeclineInvitations extends Binding.Service<
  DeclineInvitations,
  "AWS.Macie2.DeclineInvitations",
  () => Effect.Effect<
    (
      request?: macie2.DeclineInvitationsRequest,
    ) => Effect.Effect<
      macie2.DeclineInvitationsResponse,
      macie2.DeclineInvitationsError
    >
  >
> {}
export const DeclineInvitations = Binding.Service<DeclineInvitations>(
  "AWS.Macie2.DeclineInvitations",
);

import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:DeclineInvitations`.
 *
 * Declines Security Hub membership invitations from the specified accounts.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.DeclineInvitationsHttp)`.
 * @binding
 * @section Members & Organization
 * @example Decline Invitations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const declineInvitations = yield* AWS.SecurityHub.DeclineInvitations();
 *
 * // runtime
 * yield* declineInvitations({ AccountIds: ["111122223333"] });
 * ```
 */
export interface DeclineInvitations extends Binding.Service<
  DeclineInvitations,
  "AWS.SecurityHub.DeclineInvitations",
  () => Effect.Effect<
    (
      request?: securityhub.DeclineInvitationsRequest,
    ) => Effect.Effect<
      securityhub.DeclineInvitationsResponse,
      securityhub.DeclineInvitationsError
    >
  >
> {}
export const DeclineInvitations = Binding.Service<DeclineInvitations>(
  "AWS.SecurityHub.DeclineInvitations",
);

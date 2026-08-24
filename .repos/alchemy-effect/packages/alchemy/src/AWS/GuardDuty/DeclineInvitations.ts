import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `guardduty:DeclineInvitations`.
 *
 * Declines membership invitations from the given administrator account ids.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.DeclineInvitationsHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example Decline Invitations
 * ```typescript
 * // init
 * // init — account-level binding, no resource argument
 * const declineInvitations = yield* AWS.GuardDuty.DeclineInvitations();
 *
 * // runtime
 * yield* declineInvitations({ AccountIds: ["111122223333"] });
 * ```
 */
export interface DeclineInvitations extends Binding.Service<
  DeclineInvitations,
  "AWS.GuardDuty.DeclineInvitations",
  () => Effect.Effect<
    (
      request?: guardduty.DeclineInvitationsRequest,
    ) => Effect.Effect<
      guardduty.DeclineInvitationsResponse,
      guardduty.DeclineInvitationsError
    >
  >
> {}
export const DeclineInvitations = Binding.Service<DeclineInvitations>(
  "AWS.GuardDuty.DeclineInvitations",
);

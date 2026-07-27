import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `guardduty:ListInvitations`.
 *
 * Lists GuardDuty membership invitations *received by this account* — ready for an automation that auto-accepts invitations from the security account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.ListInvitationsHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example List Pending Invitations
 * ```typescript
 * // init
 * // init — account-level binding, no resource argument
 * const listInvitations = yield* AWS.GuardDuty.ListInvitations();
 *
 * // runtime
 * const { Invitations } = yield* listInvitations();
 * ```
 */
export interface ListInvitations extends Binding.Service<
  ListInvitations,
  "AWS.GuardDuty.ListInvitations",
  () => Effect.Effect<
    (
      request?: guardduty.ListInvitationsRequest,
    ) => Effect.Effect<
      guardduty.ListInvitationsResponse,
      guardduty.ListInvitationsError
    >
  >
> {}
export const ListInvitations = Binding.Service<ListInvitations>(
  "AWS.GuardDuty.ListInvitations",
);

import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `guardduty:GetInvitationsCount`.
 *
 * Counts the membership invitations received by this account, excluding deleted ones.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.GetInvitationsCountHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example Count Invitations
 * ```typescript
 * // init
 * // init — account-level binding, no resource argument
 * const getInvitationsCount = yield* AWS.GuardDuty.GetInvitationsCount();
 *
 * // runtime
 * const { InvitationsCount } = yield* getInvitationsCount();
 * ```
 */
export interface GetInvitationsCount extends Binding.Service<
  GetInvitationsCount,
  "AWS.GuardDuty.GetInvitationsCount",
  () => Effect.Effect<
    (
      request?: guardduty.GetInvitationsCountRequest,
    ) => Effect.Effect<
      guardduty.GetInvitationsCountResponse,
      guardduty.GetInvitationsCountError
    >
  >
> {}
export const GetInvitationsCount = Binding.Service<GetInvitationsCount>(
  "AWS.GuardDuty.GetInvitationsCount",
);

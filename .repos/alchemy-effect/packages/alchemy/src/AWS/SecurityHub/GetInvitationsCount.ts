import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:GetInvitationsCount`.
 *
 * Returns the count of membership invitations received by this account (excluding accepted ones).
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.GetInvitationsCountHttp)`.
 * @binding
 * @section Members & Organization
 * @example Count Pending Invitations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getInvitationsCount = yield* AWS.SecurityHub.GetInvitationsCount();
 *
 * // runtime
 * const { InvitationsCount } = yield* getInvitationsCount();
 * ```
 */
export interface GetInvitationsCount extends Binding.Service<
  GetInvitationsCount,
  "AWS.SecurityHub.GetInvitationsCount",
  () => Effect.Effect<
    (
      request?: securityhub.GetInvitationsCountRequest,
    ) => Effect.Effect<
      securityhub.GetInvitationsCountResponse,
      securityhub.GetInvitationsCountError
    >
  >
> {}
export const GetInvitationsCount = Binding.Service<GetInvitationsCount>(
  "AWS.SecurityHub.GetInvitationsCount",
);

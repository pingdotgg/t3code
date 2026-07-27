import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetInvitationsCount`.
 *
 * Retrieves the count of Amazon Macie membership invitations that were received by an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetInvitationsCountHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example Count Pending Invitations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getInvitationsCount = yield* AWS.Macie2.GetInvitationsCount();
 *
 * // runtime
 * const { invitationsCount } = yield* getInvitationsCount();
 * ```
 */
export interface GetInvitationsCount extends Binding.Service<
  GetInvitationsCount,
  "AWS.Macie2.GetInvitationsCount",
  () => Effect.Effect<
    (
      request?: macie2.GetInvitationsCountRequest,
    ) => Effect.Effect<
      macie2.GetInvitationsCountResponse,
      macie2.GetInvitationsCountError
    >
  >
> {}
export const GetInvitationsCount = Binding.Service<GetInvitationsCount>(
  "AWS.Macie2.GetInvitationsCount",
);

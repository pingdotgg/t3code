import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListInvitations`.
 *
 * Retrieves information about Amazon Macie membership invitations that were received by an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListInvitationsHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example List Pending Invitations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listInvitations = yield* AWS.Macie2.ListInvitations();
 *
 * // runtime
 * const { invitations } = yield* listInvitations();
 * ```
 */
export interface ListInvitations extends Binding.Service<
  ListInvitations,
  "AWS.Macie2.ListInvitations",
  () => Effect.Effect<
    (
      request?: macie2.ListInvitationsRequest,
    ) => Effect.Effect<
      macie2.ListInvitationsResponse,
      macie2.ListInvitationsError
    >
  >
> {}
export const ListInvitations = Binding.Service<ListInvitations>(
  "AWS.Macie2.ListInvitations",
);

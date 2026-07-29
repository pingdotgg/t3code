import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:CreateInvitations`.
 *
 * Sends an Amazon Macie membership invitation to one or more accounts.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.CreateInvitationsHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example Invite Member Accounts
 * ```typescript
 * // init — account-level binding, no resource argument
 * const createInvitations = yield* AWS.Macie2.CreateInvitations();
 *
 * // runtime
 * const { unprocessedAccounts } = yield* createInvitations({ accountIds });
 * ```
 */
export interface CreateInvitations extends Binding.Service<
  CreateInvitations,
  "AWS.Macie2.CreateInvitations",
  () => Effect.Effect<
    (
      request?: macie2.CreateInvitationsRequest,
    ) => Effect.Effect<
      macie2.CreateInvitationsResponse,
      macie2.CreateInvitationsError
    >
  >
> {}
export const CreateInvitations = Binding.Service<CreateInvitations>(
  "AWS.Macie2.CreateInvitations",
);

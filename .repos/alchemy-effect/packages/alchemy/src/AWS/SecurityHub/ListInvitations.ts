import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:ListInvitations`.
 *
 * Lists the Security Hub membership invitations received by this account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.ListInvitationsHttp)`.
 * @binding
 * @section Members & Organization
 * @example List Invitations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listInvitations = yield* AWS.SecurityHub.ListInvitations();
 *
 * // runtime
 * const { Invitations } = yield* listInvitations();
 * ```
 */
export interface ListInvitations extends Binding.Service<
  ListInvitations,
  "AWS.SecurityHub.ListInvitations",
  () => Effect.Effect<
    (
      request?: securityhub.ListInvitationsRequest,
    ) => Effect.Effect<
      securityhub.ListInvitationsResponse,
      securityhub.ListInvitationsError
    >
  >
> {}
export const ListInvitations = Binding.Service<ListInvitations>(
  "AWS.SecurityHub.ListInvitations",
);

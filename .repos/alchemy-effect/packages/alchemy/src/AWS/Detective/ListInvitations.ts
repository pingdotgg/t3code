import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `detective:ListInvitations`.
 *
 * Lists open behavior-graph invitations *received by this account* — the
 * member-account side of the Detective handshake, ready for an automation
 * that auto-accepts invitations from the security account.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.ListInvitationsHttp)`.
 * @binding
 * @section Responding to Invitations
 * @example List Pending Invitations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listInvitations = yield* AWS.Detective.ListInvitations();
 *
 * // runtime
 * const { Invitations } = yield* listInvitations();
 * ```
 */
export interface ListInvitations extends Binding.Service<
  ListInvitations,
  "AWS.Detective.ListInvitations",
  () => Effect.Effect<
    (
      request?: detective.ListInvitationsRequest,
    ) => Effect.Effect<
      detective.ListInvitationsResponse,
      detective.ListInvitationsError
    >
  >
> {}
export const ListInvitations = Binding.Service<ListInvitations>(
  "AWS.Detective.ListInvitations",
);

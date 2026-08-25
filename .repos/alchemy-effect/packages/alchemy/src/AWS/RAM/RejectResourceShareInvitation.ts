import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:RejectResourceShareInvitation`.
 *
 * Rejects an invitation to a resource share from another account.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.RejectResourceShareInvitationHttp)`.
 * @binding
 * @section Invitations
 * @example Reject an Invitation
 * ```typescript
 * // init — account-level binding, no resource argument
 * const rejectResourceShareInvitation = yield* AWS.RAM.RejectResourceShareInvitation();
 *
 * // runtime
 * const { resourceShareInvitation } =
 *   yield* rejectResourceShareInvitation({
 *     resourceShareInvitationArn: invitationArn,
 *   });
 * ```
 */
export interface RejectResourceShareInvitation extends Binding.Service<
  RejectResourceShareInvitation,
  "AWS.RAM.RejectResourceShareInvitation",
  () => Effect.Effect<
    (
      request: ram.RejectResourceShareInvitationRequest,
    ) => Effect.Effect<
      ram.RejectResourceShareInvitationResponse,
      ram.RejectResourceShareInvitationError
    >
  >
> {}
export const RejectResourceShareInvitation =
  Binding.Service<RejectResourceShareInvitation>(
    "AWS.RAM.RejectResourceShareInvitation",
  );

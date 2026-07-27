import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:AcceptResourceShareInvitation`.
 *
 * Accepts an invitation to a resource share from another account, granting this account access to the shared resources.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.AcceptResourceShareInvitationHttp)`.
 * @binding
 * @section Invitations
 * @example Accept an Invitation
 * ```typescript
 * // init — account-level binding, no resource argument
 * const acceptResourceShareInvitation = yield* AWS.RAM.AcceptResourceShareInvitation();
 *
 * // runtime
 * const { resourceShareInvitation } =
 *   yield* acceptResourceShareInvitation({
 *     resourceShareInvitationArn: invitationArn,
 *   });
 * ```
 */
export interface AcceptResourceShareInvitation extends Binding.Service<
  AcceptResourceShareInvitation,
  "AWS.RAM.AcceptResourceShareInvitation",
  () => Effect.Effect<
    (
      request: ram.AcceptResourceShareInvitationRequest,
    ) => Effect.Effect<
      ram.AcceptResourceShareInvitationResponse,
      ram.AcceptResourceShareInvitationError
    >
  >
> {}
export const AcceptResourceShareInvitation =
  Binding.Service<AcceptResourceShareInvitation>(
    "AWS.RAM.AcceptResourceShareInvitation",
  );

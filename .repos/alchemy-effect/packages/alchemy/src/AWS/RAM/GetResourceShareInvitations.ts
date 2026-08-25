import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:GetResourceShareInvitations`.
 *
 * Retrieves the invitations to resource shares that other accounts extended to you.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.GetResourceShareInvitationsHttp)`.
 * @binding
 * @section Invitations
 * @example List Your Pending Invitations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getResourceShareInvitations = yield* AWS.RAM.GetResourceShareInvitations();
 *
 * // runtime
 * const { resourceShareInvitations } =
 *   yield* getResourceShareInvitations();
 * ```
 */
export interface GetResourceShareInvitations extends Binding.Service<
  GetResourceShareInvitations,
  "AWS.RAM.GetResourceShareInvitations",
  () => Effect.Effect<
    (
      request?: ram.GetResourceShareInvitationsRequest,
    ) => Effect.Effect<
      ram.GetResourceShareInvitationsResponse,
      ram.GetResourceShareInvitationsError
    >
  >
> {}
export const GetResourceShareInvitations =
  Binding.Service<GetResourceShareInvitations>(
    "AWS.RAM.GetResourceShareInvitations",
  );

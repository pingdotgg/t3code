import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `detective:DisassociateMembership`.
 *
 * Removes *this* account from a behavior graph it previously accepted an
 * invitation to — the member-side exit, mirroring the admin's
 * `DeleteMembers`.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.DisassociateMembershipHttp)`.
 * @binding
 * @section Responding to Invitations
 * @example Leave A Behavior Graph
 * ```typescript
 * // init — account-level binding, no resource argument
 * const disassociateMembership = yield* AWS.Detective.DisassociateMembership();
 *
 * // runtime
 * yield* disassociateMembership({ GraphArn: adminGraphArn });
 * ```
 */
export interface DisassociateMembership extends Binding.Service<
  DisassociateMembership,
  "AWS.Detective.DisassociateMembership",
  () => Effect.Effect<
    (
      request: detective.DisassociateMembershipRequest,
    ) => Effect.Effect<
      detective.DisassociateMembershipResponse,
      detective.DisassociateMembershipError
    >
  >
> {}
export const DisassociateMembership = Binding.Service<DisassociateMembership>(
  "AWS.Detective.DisassociateMembership",
);

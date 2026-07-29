import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:DisassociateMembers`.
 *
 * Disassociates the specified member accounts from this administrator account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.DisassociateMembersHttp)`.
 * @binding
 * @section Members & Organization
 * @example Disassociate Members
 * ```typescript
 * // init — account-level binding, no resource argument
 * const disassociateMembers = yield* AWS.SecurityHub.DisassociateMembers();
 *
 * // runtime
 * yield* disassociateMembers({ AccountIds: ["111122223333"] });
 * ```
 */
export interface DisassociateMembers extends Binding.Service<
  DisassociateMembers,
  "AWS.SecurityHub.DisassociateMembers",
  () => Effect.Effect<
    (
      request?: securityhub.DisassociateMembersRequest,
    ) => Effect.Effect<
      securityhub.DisassociateMembersResponse,
      securityhub.DisassociateMembersError
    >
  >
> {}
export const DisassociateMembers = Binding.Service<DisassociateMembers>(
  "AWS.SecurityHub.DisassociateMembers",
);

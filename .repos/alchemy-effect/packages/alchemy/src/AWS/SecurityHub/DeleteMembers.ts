import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:DeleteMembers`.
 *
 * Deletes the member associations for the specified accounts.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.DeleteMembersHttp)`.
 * @binding
 * @section Members & Organization
 * @example Delete Members
 * ```typescript
 * // init — account-level binding, no resource argument
 * const deleteMembers = yield* AWS.SecurityHub.DeleteMembers();
 *
 * // runtime
 * yield* deleteMembers({ AccountIds: ["111122223333"] });
 * ```
 */
export interface DeleteMembers extends Binding.Service<
  DeleteMembers,
  "AWS.SecurityHub.DeleteMembers",
  () => Effect.Effect<
    (
      request?: securityhub.DeleteMembersRequest,
    ) => Effect.Effect<
      securityhub.DeleteMembersResponse,
      securityhub.DeleteMembersError
    >
  >
> {}
export const DeleteMembers = Binding.Service<DeleteMembers>(
  "AWS.SecurityHub.DeleteMembers",
);

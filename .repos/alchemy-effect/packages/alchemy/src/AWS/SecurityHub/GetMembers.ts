import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:GetMembers`.
 *
 * Returns the member details for the specified accounts.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.GetMembersHttp)`.
 * @binding
 * @section Members & Organization
 * @example Get Member Details
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getMembers = yield* AWS.SecurityHub.GetMembers();
 *
 * // runtime
 * const { Members } = yield* getMembers({ AccountIds: ["111122223333"] });
 * ```
 */
export interface GetMembers extends Binding.Service<
  GetMembers,
  "AWS.SecurityHub.GetMembers",
  () => Effect.Effect<
    (
      request?: securityhub.GetMembersRequest,
    ) => Effect.Effect<
      securityhub.GetMembersResponse,
      securityhub.GetMembersError
    >
  >
> {}
export const GetMembers = Binding.Service<GetMembers>(
  "AWS.SecurityHub.GetMembers",
);

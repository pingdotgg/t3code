import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:CreateMembers`.
 *
 * Creates member associations between this administrator account and the specified accounts.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.CreateMembersHttp)`.
 * @binding
 * @section Members & Organization
 * @example Add Member Accounts
 * ```typescript
 * // init — account-level binding, no resource argument
 * const createMembers = yield* AWS.SecurityHub.CreateMembers();
 *
 * // runtime
 * const { UnprocessedAccounts } = yield* createMembers({
 *   AccountDetails: [{ AccountId: "111122223333" }],
 * });
 * ```
 */
export interface CreateMembers extends Binding.Service<
  CreateMembers,
  "AWS.SecurityHub.CreateMembers",
  () => Effect.Effect<
    (
      request?: securityhub.CreateMembersRequest,
    ) => Effect.Effect<
      securityhub.CreateMembersResponse,
      securityhub.CreateMembersError
    >
  >
> {}
export const CreateMembers = Binding.Service<CreateMembers>(
  "AWS.SecurityHub.CreateMembers",
);

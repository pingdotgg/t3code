import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListAccountsWithInvalidEffectivePolicy`.
 *
 * Lists the accounts whose effective policy of the specified type is invalid — e.g. exceeds the size limit after policy inheritance.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListAccountsWithInvalidEffectivePolicyHttp)`.
 * @binding
 * @section Policies & Effective Policy
 * @example Audit Invalid Effective Policies
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listAccountsWithInvalidEffectivePolicy = yield* AWS.Organizations.ListAccountsWithInvalidEffectivePolicy();
 *
 * // runtime
 * const { Accounts } = yield* listAccountsWithInvalidEffectivePolicy({
 *   PolicyType: "TAG_POLICY",
 * });
 * ```
 */
export interface ListAccountsWithInvalidEffectivePolicy extends Binding.Service<
  ListAccountsWithInvalidEffectivePolicy,
  "AWS.Organizations.ListAccountsWithInvalidEffectivePolicy",
  () => Effect.Effect<
    (
      request: organizations.ListAccountsWithInvalidEffectivePolicyRequest,
    ) => Effect.Effect<
      organizations.ListAccountsWithInvalidEffectivePolicyResponse,
      organizations.ListAccountsWithInvalidEffectivePolicyError
    >
  >
> {}
export const ListAccountsWithInvalidEffectivePolicy =
  Binding.Service<ListAccountsWithInvalidEffectivePolicy>(
    "AWS.Organizations.ListAccountsWithInvalidEffectivePolicy",
  );

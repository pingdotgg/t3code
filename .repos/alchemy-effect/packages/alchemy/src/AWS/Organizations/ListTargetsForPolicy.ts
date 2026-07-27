import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListTargetsForPolicy`.
 *
 * Lists all roots, organizational units, and accounts that the specified policy is attached to.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListTargetsForPolicyHttp)`.
 * @binding
 * @section Policies & Effective Policy
 * @example List a Policy's Targets
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listTargetsForPolicy = yield* AWS.Organizations.ListTargetsForPolicy();
 *
 * // runtime
 * const { Targets } = yield* listTargetsForPolicy({ PolicyId: policyId });
 * ```
 */
export interface ListTargetsForPolicy extends Binding.Service<
  ListTargetsForPolicy,
  "AWS.Organizations.ListTargetsForPolicy",
  () => Effect.Effect<
    (
      request: organizations.ListTargetsForPolicyRequest,
    ) => Effect.Effect<
      organizations.ListTargetsForPolicyResponse,
      organizations.ListTargetsForPolicyError
    >
  >
> {}
export const ListTargetsForPolicy = Binding.Service<ListTargetsForPolicy>(
  "AWS.Organizations.ListTargetsForPolicy",
);

import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListPolicies`.
 *
 * Lists all policies of the specified type (service control, tag, backup, AI-services opt-out, …) in the organization.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListPoliciesHttp)`.
 * @binding
 * @section Policies & Effective Policy
 * @example List Service Control Policies
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listPolicies = yield* AWS.Organizations.ListPolicies();
 *
 * // runtime
 * const { Policies } = yield* listPolicies({ Filter: "SERVICE_CONTROL_POLICY" });
 * ```
 */
export interface ListPolicies extends Binding.Service<
  ListPolicies,
  "AWS.Organizations.ListPolicies",
  () => Effect.Effect<
    (
      request: organizations.ListPoliciesRequest,
    ) => Effect.Effect<
      organizations.ListPoliciesResponse,
      organizations.ListPoliciesError
    >
  >
> {}
export const ListPolicies = Binding.Service<ListPolicies>(
  "AWS.Organizations.ListPolicies",
);

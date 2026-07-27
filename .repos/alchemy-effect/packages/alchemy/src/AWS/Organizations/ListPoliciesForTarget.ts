import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListPoliciesForTarget`.
 *
 * Lists the policies of the specified type that are directly attached to the specified target root, OU, or account.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListPoliciesForTargetHttp)`.
 * @binding
 * @section Policies & Effective Policy
 * @example List Policies Attached to a Target
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listPoliciesForTarget = yield* AWS.Organizations.ListPoliciesForTarget();
 *
 * // runtime
 * const { Policies } = yield* listPoliciesForTarget({
 *   TargetId: accountId,
 *   Filter: "SERVICE_CONTROL_POLICY",
 * });
 * ```
 */
export interface ListPoliciesForTarget extends Binding.Service<
  ListPoliciesForTarget,
  "AWS.Organizations.ListPoliciesForTarget",
  () => Effect.Effect<
    (
      request: organizations.ListPoliciesForTargetRequest,
    ) => Effect.Effect<
      organizations.ListPoliciesForTargetResponse,
      organizations.ListPoliciesForTargetError
    >
  >
> {}
export const ListPoliciesForTarget = Binding.Service<ListPoliciesForTarget>(
  "AWS.Organizations.ListPoliciesForTarget",
);

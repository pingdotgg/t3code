import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListPolicies}.
 */
export interface ListPoliciesRequest extends fms.ListPoliciesRequest {}

/**
 * Runtime binding for `fms:ListPolicies`.
 *
 * Returns the `PolicySummary` list for the Firewall Manager policies in the administrator's account. Provide the
 * implementation with `Effect.provide(AWS.FMS.ListPoliciesHttp)`.
 * @binding
 * @section Reading Policies
 * @example List Policies
 * ```typescript
 * // init — account-level binding takes no resource
 * const listPolicies = yield* AWS.FMS.ListPolicies();
 *
 * // runtime
 * const result = yield* listPolicies();
 * console.log(result.PolicyList?.length);
 * ```
 */
export interface ListPolicies extends Binding.Service<
  ListPolicies,
  "AWS.FMS.ListPolicies",
  () => Effect.Effect<
    (
      request?: ListPoliciesRequest,
    ) => Effect.Effect<fms.ListPoliciesResponse, fms.ListPoliciesError>
  >
> {}

export const ListPolicies = Binding.Service<ListPolicies>(
  "AWS.FMS.ListPolicies",
);

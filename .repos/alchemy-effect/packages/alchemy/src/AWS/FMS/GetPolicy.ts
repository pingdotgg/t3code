import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetPolicy}.
 */
export interface GetPolicyRequest extends fms.GetPolicyRequest {}

/**
 * Runtime binding for `fms:GetPolicy`.
 *
 * Returns the specified Firewall Manager policy. Provide the
 * implementation with `Effect.provide(AWS.FMS.GetPolicyHttp)`.
 * @binding
 * @section Reading Policies
 * @example Read a Policy
 * ```typescript
 * // init — account-level binding takes no resource
 * const getPolicy = yield* AWS.FMS.GetPolicy();
 *
 * // runtime
 * const result = yield* getPolicy({ PolicyId: policyId });
 * console.log(result.Policy?.PolicyName);
 * ```
 */
export interface GetPolicy extends Binding.Service<
  GetPolicy,
  "AWS.FMS.GetPolicy",
  () => Effect.Effect<
    (
      request: GetPolicyRequest,
    ) => Effect.Effect<fms.GetPolicyResponse, fms.GetPolicyError>
  >
> {}

export const GetPolicy = Binding.Service<GetPolicy>("AWS.FMS.GetPolicy");

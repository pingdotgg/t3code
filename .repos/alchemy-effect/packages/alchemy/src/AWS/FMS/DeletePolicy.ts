import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link DeletePolicy}.
 */
export interface DeletePolicyRequest extends fms.DeletePolicyRequest {}

/**
 * Runtime binding for `fms:DeletePolicy`.
 *
 * Permanently deletes the specified Firewall Manager policy, optionally cleaning up the resources it created in member accounts. Provide the
 * implementation with `Effect.provide(AWS.FMS.DeletePolicyHttp)`.
 * @binding
 * @section Managing Policies
 * @example Delete a Policy
 * ```typescript
 * // init — account-level binding takes no resource
 * const deletePolicy = yield* AWS.FMS.DeletePolicy();
 *
 * // runtime
 * yield* deletePolicy({ PolicyId: policyId, DeleteAllPolicyResources: true });
 * ```
 */
export interface DeletePolicy extends Binding.Service<
  DeletePolicy,
  "AWS.FMS.DeletePolicy",
  () => Effect.Effect<
    (
      request: DeletePolicyRequest,
    ) => Effect.Effect<fms.DeletePolicyResponse, fms.DeletePolicyError>
  >
> {}

export const DeletePolicy = Binding.Service<DeletePolicy>(
  "AWS.FMS.DeletePolicy",
);

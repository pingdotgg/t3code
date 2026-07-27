import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuleGroup } from "./RuleGroup.ts";

/**
 * Runtime binding for `wafv2:DeletePermissionPolicy` — remove the IAM
 * policy that shares the bound {@link RuleGroup} with other accounts; the
 * rule group ARN is injected automatically. Deleting a policy that does
 * not exist succeeds.
 *
 * Provide `WAFv2.DeletePermissionPolicyHttp` on the hosting Lambda Function
 * to satisfy the requirement.
 * @binding
 * @section Sharing Rule Groups
 * @example Stop Sharing the Rule Group
 * ```typescript
 * // init — grants wafv2:DeletePermissionPolicy on the rule group
 * const deletePermissionPolicy = yield* AWS.WAFv2.DeletePermissionPolicy(group);
 *
 * // runtime
 * yield* deletePermissionPolicy();
 * ```
 */
export interface DeletePermissionPolicy extends Binding.Service<
  DeletePermissionPolicy,
  "AWS.WAFv2.DeletePermissionPolicy",
  (
    ruleGroup: RuleGroup,
  ) => Effect.Effect<
    () => Effect.Effect<
      WAFV2.DeletePermissionPolicyResponse,
      WAFV2.DeletePermissionPolicyError
    >
  >
> {}

export const DeletePermissionPolicy = Binding.Service<DeletePermissionPolicy>(
  "AWS.WAFv2.DeletePermissionPolicy",
);

import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuleGroup } from "./RuleGroup.ts";

export interface PutPermissionPolicyRequest extends Omit<
  WAFV2.PutPermissionPolicyRequest,
  "ResourceArn"
> {}

/**
 * Runtime binding for `wafv2:PutPermissionPolicy` — attach an IAM policy
 * that shares the bound {@link RuleGroup} with other accounts (e.g. a SaaS
 * granting tenant accounts the right to reference the group from their web
 * ACLs); the rule group ARN is injected automatically. A malformed policy
 * fails with the typed `WAFInvalidPermissionPolicyException`.
 *
 * Provide `WAFv2.PutPermissionPolicyHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Sharing Rule Groups
 * @example Share the Rule Group with Another Account
 * ```typescript
 * // init — grants wafv2:PutPermissionPolicy on the rule group
 * const putPermissionPolicy = yield* AWS.WAFv2.PutPermissionPolicy(group);
 *
 * // runtime
 * yield* putPermissionPolicy({
 *   Policy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: "arn:aws:iam::123456789012:root" },
 *         Action: ["wafv2:CreateWebACL", "wafv2:UpdateWebACL"],
 *         Resource: group.ruleGroupArn,
 *       },
 *     ],
 *   }),
 * });
 * ```
 */
export interface PutPermissionPolicy extends Binding.Service<
  PutPermissionPolicy,
  "AWS.WAFv2.PutPermissionPolicy",
  (
    ruleGroup: RuleGroup,
  ) => Effect.Effect<
    (
      request: PutPermissionPolicyRequest,
    ) => Effect.Effect<
      WAFV2.PutPermissionPolicyResponse,
      WAFV2.PutPermissionPolicyError
    >
  >
> {}

export const PutPermissionPolicy = Binding.Service<PutPermissionPolicy>(
  "AWS.WAFv2.PutPermissionPolicy",
);

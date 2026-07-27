import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuleGroup } from "./RuleGroup.ts";

/**
 * Runtime binding for `wafv2:GetPermissionPolicy` — read the IAM policy
 * that shares the bound {@link RuleGroup} with other accounts; the rule
 * group ARN is injected automatically. A rule group with no policy
 * attached fails with the typed `WAFNonexistentItemException`.
 *
 * Provide `WAFv2.GetPermissionPolicyHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Sharing Rule Groups
 * @example Read the Sharing Policy
 * ```typescript
 * // init — grants wafv2:GetPermissionPolicy on the rule group
 * const getPermissionPolicy = yield* AWS.WAFv2.GetPermissionPolicy(group);
 *
 * // runtime
 * const { Policy } = yield* getPermissionPolicy().pipe(
 *   Effect.catchTag("WAFNonexistentItemException", () =>
 *     Effect.succeed({ Policy: undefined }),
 *   ),
 * );
 * ```
 */
export interface GetPermissionPolicy extends Binding.Service<
  GetPermissionPolicy,
  "AWS.WAFv2.GetPermissionPolicy",
  (
    ruleGroup: RuleGroup,
  ) => Effect.Effect<
    () => Effect.Effect<
      WAFV2.GetPermissionPolicyResponse,
      WAFV2.GetPermissionPolicyError
    >
  >
> {}

export const GetPermissionPolicy = Binding.Service<GetPermissionPolicy>(
  "AWS.WAFv2.GetPermissionPolicy",
);

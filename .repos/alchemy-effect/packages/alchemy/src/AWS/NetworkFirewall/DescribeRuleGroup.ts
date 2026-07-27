import type * as NFW from "@distilled.cloud/aws/network-firewall";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuleGroup } from "./RuleGroup.ts";

export interface DescribeRuleGroupRequest extends Omit<
  NFW.DescribeRuleGroupRequest,
  "RuleGroupArn" | "RuleGroupName" | "Type"
> {}

/**
 * Runtime binding for `network-firewall:DescribeRuleGroup` — read the bound
 * {@link RuleGroup}'s definition (rules source, variables, capacity); the
 * rule group ARN is injected automatically.
 *
 * Provide `NetworkFirewall.DescribeRuleGroupHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Rule Group State
 * @example Read the Rule Group Definition
 * ```typescript
 * // init — grants network-firewall:DescribeRuleGroup on the rule group
 * const describeRuleGroup =
 *   yield* AWS.NetworkFirewall.DescribeRuleGroup(ruleGroup);
 *
 * // runtime
 * const { RuleGroup } = yield* describeRuleGroup();
 * ```
 */
export interface DescribeRuleGroup extends Binding.Service<
  DescribeRuleGroup,
  "AWS.NetworkFirewall.DescribeRuleGroup",
  (
    ruleGroup: RuleGroup,
  ) => Effect.Effect<
    (
      request?: DescribeRuleGroupRequest,
    ) => Effect.Effect<
      NFW.DescribeRuleGroupResponse,
      NFW.DescribeRuleGroupError
    >
  >
> {}

export const DescribeRuleGroup = Binding.Service<DescribeRuleGroup>(
  "AWS.NetworkFirewall.DescribeRuleGroup",
);

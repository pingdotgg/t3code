import type * as NFW from "@distilled.cloud/aws/network-firewall";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuleGroup } from "./RuleGroup.ts";

export interface DescribeRuleGroupSummaryRequest extends Omit<
  NFW.DescribeRuleGroupSummaryRequest,
  "RuleGroupArn" | "RuleGroupName" | "Type"
> {}

/**
 * Runtime binding for `network-firewall:DescribeRuleGroupSummary` — read a
 * per-rule summary (SID, message, metadata) of the bound stateful
 * {@link RuleGroup}; the rule group ARN is injected automatically. Only
 * supported for `STATEFUL` rule groups.
 *
 * Provide `NetworkFirewall.DescribeRuleGroupSummaryHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * @binding
 * @section Reading Rule Group State
 * @example Summarize the Stateful Rules
 * ```typescript
 * // init — grants network-firewall:DescribeRuleGroupSummary on the rule group
 * const describeRuleGroupSummary =
 *   yield* AWS.NetworkFirewall.DescribeRuleGroupSummary(ruleGroup);
 *
 * // runtime
 * const { Summary } = yield* describeRuleGroupSummary();
 * ```
 */
export interface DescribeRuleGroupSummary extends Binding.Service<
  DescribeRuleGroupSummary,
  "AWS.NetworkFirewall.DescribeRuleGroupSummary",
  (
    ruleGroup: RuleGroup,
  ) => Effect.Effect<
    (
      request?: DescribeRuleGroupSummaryRequest,
    ) => Effect.Effect<
      NFW.DescribeRuleGroupSummaryResponse,
      NFW.DescribeRuleGroupSummaryError
    >
  >
> {}

export const DescribeRuleGroupSummary =
  Binding.Service<DescribeRuleGroupSummary>(
    "AWS.NetworkFirewall.DescribeRuleGroupSummary",
  );

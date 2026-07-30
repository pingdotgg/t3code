import type * as NFW from "@distilled.cloud/aws/network-firewall";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuleGroup } from "./RuleGroup.ts";

export interface DescribeRuleGroupMetadataRequest extends Omit<
  NFW.DescribeRuleGroupMetadataRequest,
  "RuleGroupArn" | "RuleGroupName" | "Type"
> {}

/**
 * Runtime binding for `network-firewall:DescribeRuleGroupMetadata` — read
 * the high-level metadata (type, capacity, last-modified time) of the bound
 * {@link RuleGroup} without fetching the full rules definition; the rule
 * group ARN is injected automatically.
 *
 * Provide `NetworkFirewall.DescribeRuleGroupMetadataHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * @binding
 * @section Reading Rule Group State
 * @example Read Rule Group Metadata
 * ```typescript
 * // init — grants network-firewall:DescribeRuleGroupMetadata on the rule group
 * const describeRuleGroupMetadata =
 *   yield* AWS.NetworkFirewall.DescribeRuleGroupMetadata(ruleGroup);
 *
 * // runtime
 * const { Capacity } = yield* describeRuleGroupMetadata();
 * ```
 */
export interface DescribeRuleGroupMetadata extends Binding.Service<
  DescribeRuleGroupMetadata,
  "AWS.NetworkFirewall.DescribeRuleGroupMetadata",
  (
    ruleGroup: RuleGroup,
  ) => Effect.Effect<
    (
      request?: DescribeRuleGroupMetadataRequest,
    ) => Effect.Effect<
      NFW.DescribeRuleGroupMetadataResponse,
      NFW.DescribeRuleGroupMetadataError
    >
  >
> {}

export const DescribeRuleGroupMetadata =
  Binding.Service<DescribeRuleGroupMetadata>(
    "AWS.NetworkFirewall.DescribeRuleGroupMetadata",
  );

import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Layer from "effect/Layer";
import { makeNetworkFirewallRuleGroupHttpBinding } from "./BindingHttp.ts";
import { DescribeRuleGroup } from "./DescribeRuleGroup.ts";

export const DescribeRuleGroupHttp = Layer.effect(
  DescribeRuleGroup,
  makeNetworkFirewallRuleGroupHttpBinding({
    tag: "AWS.NetworkFirewall.DescribeRuleGroup",
    operation: nfw.describeRuleGroup,
    actions: ["network-firewall:DescribeRuleGroup"],
  }),
);

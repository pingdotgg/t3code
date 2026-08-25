import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Layer from "effect/Layer";
import { makeNetworkFirewallRuleGroupHttpBinding } from "./BindingHttp.ts";
import { DescribeRuleGroupMetadata } from "./DescribeRuleGroupMetadata.ts";

export const DescribeRuleGroupMetadataHttp = Layer.effect(
  DescribeRuleGroupMetadata,
  makeNetworkFirewallRuleGroupHttpBinding({
    tag: "AWS.NetworkFirewall.DescribeRuleGroupMetadata",
    operation: nfw.describeRuleGroupMetadata,
    actions: ["network-firewall:DescribeRuleGroupMetadata"],
  }),
);

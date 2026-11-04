import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Layer from "effect/Layer";
import { makeNetworkFirewallFirewallPolicyHttpBinding } from "./BindingHttp.ts";
import { DescribeFirewallPolicy } from "./DescribeFirewallPolicy.ts";

export const DescribeFirewallPolicyHttp = Layer.effect(
  DescribeFirewallPolicy,
  makeNetworkFirewallFirewallPolicyHttpBinding({
    tag: "AWS.NetworkFirewall.DescribeFirewallPolicy",
    operation: nfw.describeFirewallPolicy,
    actions: ["network-firewall:DescribeFirewallPolicy"],
  }),
);

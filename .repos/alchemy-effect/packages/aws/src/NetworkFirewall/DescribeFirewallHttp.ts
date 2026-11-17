import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Layer from "effect/Layer";
import { makeNetworkFirewallFirewallHttpBinding } from "./BindingHttp.ts";
import { DescribeFirewall } from "./DescribeFirewall.ts";

export const DescribeFirewallHttp = Layer.effect(
  DescribeFirewall,
  makeNetworkFirewallFirewallHttpBinding({
    tag: "AWS.NetworkFirewall.DescribeFirewall",
    operation: nfw.describeFirewall,
    actions: ["network-firewall:DescribeFirewall"],
  }),
);

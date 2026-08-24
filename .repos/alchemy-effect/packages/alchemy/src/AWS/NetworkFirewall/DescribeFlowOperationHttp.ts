import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Layer from "effect/Layer";
import { makeNetworkFirewallFirewallHttpBinding } from "./BindingHttp.ts";
import { DescribeFlowOperation } from "./DescribeFlowOperation.ts";

export const DescribeFlowOperationHttp = Layer.effect(
  DescribeFlowOperation,
  makeNetworkFirewallFirewallHttpBinding({
    tag: "AWS.NetworkFirewall.DescribeFlowOperation",
    operation: nfw.describeFlowOperation,
    actions: ["network-firewall:DescribeFlowOperation"],
  }),
);

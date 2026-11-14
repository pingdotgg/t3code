import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Layer from "effect/Layer";
import { makeNetworkFirewallFirewallHttpBinding } from "./BindingHttp.ts";
import { StartFlowFlush } from "./StartFlowFlush.ts";

export const StartFlowFlushHttp = Layer.effect(
  StartFlowFlush,
  makeNetworkFirewallFirewallHttpBinding({
    tag: "AWS.NetworkFirewall.StartFlowFlush",
    operation: nfw.startFlowFlush,
    actions: ["network-firewall:StartFlowFlush"],
  }),
);

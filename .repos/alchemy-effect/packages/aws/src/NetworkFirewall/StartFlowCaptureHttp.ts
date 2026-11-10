import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Layer from "effect/Layer";
import { makeNetworkFirewallFirewallHttpBinding } from "./BindingHttp.ts";
import { StartFlowCapture } from "./StartFlowCapture.ts";

export const StartFlowCaptureHttp = Layer.effect(
  StartFlowCapture,
  makeNetworkFirewallFirewallHttpBinding({
    tag: "AWS.NetworkFirewall.StartFlowCapture",
    operation: nfw.startFlowCapture,
    actions: ["network-firewall:StartFlowCapture"],
  }),
);

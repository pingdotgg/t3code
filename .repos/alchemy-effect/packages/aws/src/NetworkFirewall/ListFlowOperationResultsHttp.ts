import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Layer from "effect/Layer";
import { makeNetworkFirewallFirewallHttpBinding } from "./BindingHttp.ts";
import { ListFlowOperationResults } from "./ListFlowOperationResults.ts";

export const ListFlowOperationResultsHttp = Layer.effect(
  ListFlowOperationResults,
  makeNetworkFirewallFirewallHttpBinding({
    tag: "AWS.NetworkFirewall.ListFlowOperationResults",
    operation: nfw.listFlowOperationResults,
    actions: ["network-firewall:ListFlowOperationResults"],
  }),
);

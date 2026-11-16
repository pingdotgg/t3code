import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Layer from "effect/Layer";
import { makeNetworkFirewallFirewallHttpBinding } from "./BindingHttp.ts";
import { ListFlowOperations } from "./ListFlowOperations.ts";

export const ListFlowOperationsHttp = Layer.effect(
  ListFlowOperations,
  makeNetworkFirewallFirewallHttpBinding({
    tag: "AWS.NetworkFirewall.ListFlowOperations",
    operation: nfw.listFlowOperations,
    actions: ["network-firewall:ListFlowOperations"],
  }),
);

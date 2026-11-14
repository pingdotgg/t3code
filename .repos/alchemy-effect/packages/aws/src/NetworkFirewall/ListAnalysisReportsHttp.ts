import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Layer from "effect/Layer";
import { makeNetworkFirewallFirewallHttpBinding } from "./BindingHttp.ts";
import { ListAnalysisReports } from "./ListAnalysisReports.ts";

export const ListAnalysisReportsHttp = Layer.effect(
  ListAnalysisReports,
  makeNetworkFirewallFirewallHttpBinding({
    tag: "AWS.NetworkFirewall.ListAnalysisReports",
    operation: nfw.listAnalysisReports,
    actions: ["network-firewall:ListAnalysisReports"],
  }),
);

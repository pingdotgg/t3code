import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Layer from "effect/Layer";
import { makeNetworkFirewallFirewallHttpBinding } from "./BindingHttp.ts";
import { GetAnalysisReportResults } from "./GetAnalysisReportResults.ts";

export const GetAnalysisReportResultsHttp = Layer.effect(
  GetAnalysisReportResults,
  makeNetworkFirewallFirewallHttpBinding({
    tag: "AWS.NetworkFirewall.GetAnalysisReportResults",
    operation: nfw.getAnalysisReportResults,
    actions: ["network-firewall:GetAnalysisReportResults"],
  }),
);

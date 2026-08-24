import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Layer from "effect/Layer";
import { makeNetworkFirewallFirewallHttpBinding } from "./BindingHttp.ts";
import { StartAnalysisReport } from "./StartAnalysisReport.ts";

export const StartAnalysisReportHttp = Layer.effect(
  StartAnalysisReport,
  makeNetworkFirewallFirewallHttpBinding({
    tag: "AWS.NetworkFirewall.StartAnalysisReport",
    operation: nfw.startAnalysisReport,
    actions: ["network-firewall:StartAnalysisReport"],
  }),
);

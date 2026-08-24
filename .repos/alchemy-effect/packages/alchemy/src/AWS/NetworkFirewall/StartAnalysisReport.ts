import type * as NFW from "@distilled.cloud/aws/network-firewall";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Firewall } from "./Firewall.ts";

export interface StartAnalysisReportRequest extends Omit<
  NFW.StartAnalysisReportRequest,
  "FirewallArn" | "FirewallName"
> {}

/**
 * Runtime binding for `network-firewall:StartAnalysisReport` — generate a
 * traffic analysis report (`TLS_SNI` or `HTTP_HOST`) for the bound
 * {@link Firewall}; the firewall ARN is injected automatically. The
 * firewall's analysis settings must have the analysis type enabled.
 *
 * Provide `NetworkFirewall.StartAnalysisReportHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Analysis Reports
 * @example Start a TLS SNI Analysis Report
 * ```typescript
 * // init — grants network-firewall:StartAnalysisReport on the firewall
 * const startAnalysisReport =
 *   yield* AWS.NetworkFirewall.StartAnalysisReport(firewall);
 *
 * // runtime
 * const { AnalysisReportId } = yield* startAnalysisReport({
 *   AnalysisType: "TLS_SNI",
 * });
 * ```
 */
export interface StartAnalysisReport extends Binding.Service<
  StartAnalysisReport,
  "AWS.NetworkFirewall.StartAnalysisReport",
  (
    firewall: Firewall,
  ) => Effect.Effect<
    (
      request: StartAnalysisReportRequest,
    ) => Effect.Effect<
      NFW.StartAnalysisReportResponse,
      NFW.StartAnalysisReportError
    >
  >
> {}

export const StartAnalysisReport = Binding.Service<StartAnalysisReport>(
  "AWS.NetworkFirewall.StartAnalysisReport",
);

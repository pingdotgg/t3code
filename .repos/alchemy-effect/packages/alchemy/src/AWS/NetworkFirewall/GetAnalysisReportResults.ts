import type * as NFW from "@distilled.cloud/aws/network-firewall";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Firewall } from "./Firewall.ts";

export interface GetAnalysisReportResultsRequest extends Omit<
  NFW.GetAnalysisReportResultsRequest,
  "FirewallArn" | "FirewallName"
> {}

/**
 * Runtime binding for `network-firewall:GetAnalysisReportResults` — read the
 * results of a completed traffic analysis report on the bound
 * {@link Firewall}; the firewall ARN is injected automatically.
 *
 * Provide `NetworkFirewall.GetAnalysisReportResultsHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * @binding
 * @section Analysis Reports
 * @example Read Analysis Report Results
 * ```typescript
 * // init — grants network-firewall:GetAnalysisReportResults on the firewall
 * const getAnalysisReportResults =
 *   yield* AWS.NetworkFirewall.GetAnalysisReportResults(firewall);
 *
 * // runtime
 * const { AnalysisReportResults } = yield* getAnalysisReportResults({
 *   AnalysisReportId: analysisReportId,
 * });
 * ```
 */
export interface GetAnalysisReportResults extends Binding.Service<
  GetAnalysisReportResults,
  "AWS.NetworkFirewall.GetAnalysisReportResults",
  (
    firewall: Firewall,
  ) => Effect.Effect<
    (
      request: GetAnalysisReportResultsRequest,
    ) => Effect.Effect<
      NFW.GetAnalysisReportResultsResponse,
      NFW.GetAnalysisReportResultsError
    >
  >
> {}

export const GetAnalysisReportResults =
  Binding.Service<GetAnalysisReportResults>(
    "AWS.NetworkFirewall.GetAnalysisReportResults",
  );

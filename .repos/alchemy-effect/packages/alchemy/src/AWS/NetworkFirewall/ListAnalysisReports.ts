import type * as NFW from "@distilled.cloud/aws/network-firewall";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Firewall } from "./Firewall.ts";

export interface ListAnalysisReportsRequest extends Omit<
  NFW.ListAnalysisReportsRequest,
  "FirewallArn" | "FirewallName"
> {}

/**
 * Runtime binding for `network-firewall:ListAnalysisReports` — list the
 * traffic analysis reports generated for the bound {@link Firewall}; the
 * firewall ARN is injected automatically.
 *
 * Provide `NetworkFirewall.ListAnalysisReportsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Analysis Reports
 * @example List Analysis Reports
 * ```typescript
 * // init — grants network-firewall:ListAnalysisReports on the firewall
 * const listAnalysisReports =
 *   yield* AWS.NetworkFirewall.ListAnalysisReports(firewall);
 *
 * // runtime
 * const { AnalysisReports } = yield* listAnalysisReports();
 * ```
 */
export interface ListAnalysisReports extends Binding.Service<
  ListAnalysisReports,
  "AWS.NetworkFirewall.ListAnalysisReports",
  (
    firewall: Firewall,
  ) => Effect.Effect<
    (
      request?: ListAnalysisReportsRequest,
    ) => Effect.Effect<
      NFW.ListAnalysisReportsResponse,
      NFW.ListAnalysisReportsError
    >
  >
> {}

export const ListAnalysisReports = Binding.Service<ListAnalysisReports>(
  "AWS.NetworkFirewall.ListAnalysisReports",
);

import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `inspector2:GetCisScanReport`.
 *
 * Retrieves a CIS scan report.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.GetCisScanReportHttp)`.
 * ### CIS Scan Results
 * **Example:** Download a CIS Scan Report
 * ```typescript
 * // init
 * const getCisScanReport = yield* AWS.Inspector2.GetCisScanReport();
 *
 * // runtime
 * const { url, status } = yield* getCisScanReport({ scanArn });
 * ```
 *
 * @binding
 */
export interface GetCisScanReport extends Binding.Service<
  GetCisScanReport,
  "AWS.Inspector2.GetCisScanReport",
  () => Effect.Effect<
    (
      request: inspector2.GetCisScanReportRequest,
    ) => Effect.Effect<inspector2.GetCisScanReportResponse, inspector2.GetCisScanReportError>
  >
> {}
export const GetCisScanReport = Binding.Service<GetCisScanReport>(
  "AWS.Inspector2.GetCisScanReport",
);

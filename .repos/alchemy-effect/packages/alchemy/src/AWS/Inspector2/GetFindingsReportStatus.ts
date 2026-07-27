import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:GetFindingsReportStatus`.
 *
 * Gets the status of a findings report.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.GetFindingsReportStatusHttp)`.
 * @binding
 * @section Findings Reports & SBOM Exports
 * @example Poll a Findings Report
 * ```typescript
 * // init
 * const getFindingsReportStatus = yield* AWS.Inspector2.GetFindingsReportStatus();
 *
 * // runtime
 * const { status } = yield* getFindingsReportStatus({ reportId });
 * ```
 */
export interface GetFindingsReportStatus extends Binding.Service<
  GetFindingsReportStatus,
  "AWS.Inspector2.GetFindingsReportStatus",
  () => Effect.Effect<
    (
      request?: inspector2.GetFindingsReportStatusRequest,
    ) => Effect.Effect<
      inspector2.GetFindingsReportStatusResponse,
      inspector2.GetFindingsReportStatusError
    >
  >
> {}
export const GetFindingsReportStatus = Binding.Service<GetFindingsReportStatus>(
  "AWS.Inspector2.GetFindingsReportStatus",
);

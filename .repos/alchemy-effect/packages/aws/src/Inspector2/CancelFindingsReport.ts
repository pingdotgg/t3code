import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `inspector2:CancelFindingsReport`.
 *
 * Cancels the given findings report.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.CancelFindingsReportHttp)`.
 * ### Findings Reports & SBOM Exports
 * **Example:** Cancel a Findings Report
 * ```typescript
 * // init
 * const cancelFindingsReport = yield* AWS.Inspector2.CancelFindingsReport();
 *
 * // runtime
 * yield* cancelFindingsReport({ reportId });
 * ```
 *
 * @binding
 */
export interface CancelFindingsReport extends Binding.Service<
  CancelFindingsReport,
  "AWS.Inspector2.CancelFindingsReport",
  () => Effect.Effect<
    (
      request: inspector2.CancelFindingsReportRequest,
    ) => Effect.Effect<
      inspector2.CancelFindingsReportResponse,
      inspector2.CancelFindingsReportError
    >
  >
> {}
export const CancelFindingsReport = Binding.Service<CancelFindingsReport>(
  "AWS.Inspector2.CancelFindingsReport",
);

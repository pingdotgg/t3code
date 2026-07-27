import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReportGroup } from "./ReportGroup.ts";

/**
 * Runtime binding for `codebuild:DeleteReport` — deletes a report of the
 * bound report group by report ARN.
 * @binding
 * @section Reading Reports
 * @example Delete an Old Report
 * ```typescript
 * const deleteReport = yield* AWS.CodeBuild.DeleteReport(reportGroup);
 *
 * yield* deleteReport({ arn: reportArn });
 * ```
 */
export interface DeleteReport extends Binding.Service<
  DeleteReport,
  "AWS.CodeBuild.DeleteReport",
  <G extends ReportGroup>(
    reportGroup: G,
  ) => Effect.Effect<
    (
      request: SVC.DeleteReportInput,
    ) => Effect.Effect<SVC.DeleteReportOutput, SVC.DeleteReportError>
  >
> {}
export const DeleteReport = Binding.Service<DeleteReport>(
  "AWS.CodeBuild.DeleteReport",
);

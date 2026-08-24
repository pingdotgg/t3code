import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReportGroup } from "./ReportGroup.ts";

/**
 * Runtime binding for `codebuild:ListReportsForReportGroup` — lists the
 * bound report group's report ARNs, newest first.
 * @binding
 * @section Reading Reports
 * @example List Reports in the Group
 * ```typescript
 * const listReports = yield* AWS.CodeBuild.ListReportsForReportGroup(reportGroup);
 *
 * const { reports } = yield* listReports();
 * ```
 */
export interface ListReportsForReportGroup extends Binding.Service<
  ListReportsForReportGroup,
  "AWS.CodeBuild.ListReportsForReportGroup",
  <G extends ReportGroup>(
    reportGroup: G,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListReportsForReportGroupInput, "reportGroupArn">,
    ) => Effect.Effect<
      SVC.ListReportsForReportGroupOutput,
      SVC.ListReportsForReportGroupError
    >
  >
> {}
export const ListReportsForReportGroup =
  Binding.Service<ListReportsForReportGroup>(
    "AWS.CodeBuild.ListReportsForReportGroup",
  );

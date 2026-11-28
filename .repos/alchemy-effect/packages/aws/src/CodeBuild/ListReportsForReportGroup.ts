import type * as SVC from "@distilled.cloud/aws/codebuild";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { ReportGroup } from "./ReportGroup.ts";

/**
 * Runtime binding for `codebuild:ListReportsForReportGroup` — lists the
 * bound report group's report ARNs, newest first.
 * ### Reading Reports
 * **Example:** List Reports in the Group
 * ```typescript
 * const listReports = yield* AWS.CodeBuild.ListReportsForReportGroup(reportGroup);
 *
 * const { reports } = yield* listReports();
 * ```
 *
 * @binding
 */
export interface ListReportsForReportGroup extends Binding.Service<
  ListReportsForReportGroup,
  "AWS.CodeBuild.ListReportsForReportGroup",
  <G extends ReportGroup>(
    reportGroup: G,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListReportsForReportGroupInput, "reportGroupArn">,
    ) => Effect.Effect<SVC.ListReportsForReportGroupOutput, SVC.ListReportsForReportGroupError>
  >
> {}
export const ListReportsForReportGroup = Binding.Service<ListReportsForReportGroup>(
  "AWS.CodeBuild.ListReportsForReportGroup",
);

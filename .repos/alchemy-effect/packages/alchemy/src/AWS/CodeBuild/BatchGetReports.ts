import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReportGroup } from "./ReportGroup.ts";

/**
 * Runtime binding for `codebuild:BatchGetReports` — reads one or more
 * reports of the bound report group by report ARN.
 * @binding
 * @section Reading Reports
 * @example Read Report Summaries
 * ```typescript
 * const batchGetReports = yield* AWS.CodeBuild.BatchGetReports(reportGroup);
 *
 * const { reports } = yield* batchGetReports({ reportArns });
 * ```
 */
export interface BatchGetReports extends Binding.Service<
  BatchGetReports,
  "AWS.CodeBuild.BatchGetReports",
  <G extends ReportGroup>(
    reportGroup: G,
  ) => Effect.Effect<
    (
      request: SVC.BatchGetReportsInput,
    ) => Effect.Effect<SVC.BatchGetReportsOutput, SVC.BatchGetReportsError>
  >
> {}
export const BatchGetReports = Binding.Service<BatchGetReports>(
  "AWS.CodeBuild.BatchGetReports",
);

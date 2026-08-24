import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReportGroup } from "./ReportGroup.ts";

/**
 * Runtime binding for `codebuild:GetReportGroupTrend` — aggregates a trend
 * statistic (pass rate, duration, …) across the bound report group's most
 * recent reports.
 * @binding
 * @section Reading Reports
 * @example Read the Pass-Rate Trend
 * ```typescript
 * const getReportGroupTrend = yield* AWS.CodeBuild.GetReportGroupTrend(reportGroup);
 *
 * const { stats } = yield* getReportGroupTrend({ trendField: "PASS_RATE" });
 * ```
 */
export interface GetReportGroupTrend extends Binding.Service<
  GetReportGroupTrend,
  "AWS.CodeBuild.GetReportGroupTrend",
  <G extends ReportGroup>(
    reportGroup: G,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetReportGroupTrendInput, "reportGroupArn">,
    ) => Effect.Effect<
      SVC.GetReportGroupTrendOutput,
      SVC.GetReportGroupTrendError
    >
  >
> {}
export const GetReportGroupTrend = Binding.Service<GetReportGroupTrend>(
  "AWS.CodeBuild.GetReportGroupTrend",
);

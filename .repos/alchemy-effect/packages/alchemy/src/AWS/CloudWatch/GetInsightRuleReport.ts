import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { InsightRule } from "./InsightRule.ts";

export interface GetInsightRuleReportRequest extends Omit<
  cloudwatch.GetInsightRuleReportInput,
  "RuleName"
> {}

/**
 * Runtime binding for `cloudwatch:GetInsightRuleReport` — fetch the
 * top-contributor report for the bound {@link InsightRule}; the rule name
 * is injected automatically.
 *
 * Provide `CloudWatch.GetInsightRuleReportHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Insight Rules
 * @example Fetch the Top Contributors for a Rule
 * ```typescript
 * // init — grants cloudwatch:GetInsightRuleReport on the rule
 * const getInsightRuleReport = yield* AWS.CloudWatch.GetInsightRuleReport(rule);
 *
 * // runtime
 * const now = yield* Effect.sync(() => Date.now());
 * const result = yield* getInsightRuleReport({
 *   StartTime: new Date(now - 3_600_000),
 *   EndTime: new Date(now),
 *   Period: 300,
 * });
 * const contributors = result.Contributors ?? [];
 * ```
 */
export interface GetInsightRuleReport extends Binding.Service<
  GetInsightRuleReport,
  "AWS.CloudWatch.GetInsightRuleReport",
  (
    rule: InsightRule,
  ) => Effect.Effect<
    (
      request: GetInsightRuleReportRequest,
    ) => Effect.Effect<
      cloudwatch.GetInsightRuleReportOutput,
      cloudwatch.GetInsightRuleReportError
    >
  >
> {}

export const GetInsightRuleReport = Binding.Service<GetInsightRuleReport>(
  "AWS.CloudWatch.GetInsightRuleReport",
);

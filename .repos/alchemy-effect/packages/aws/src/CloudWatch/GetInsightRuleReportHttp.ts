import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchResourceHttpBinding } from "./BindingHttp.ts";
import { GetInsightRuleReport } from "./GetInsightRuleReport.ts";
import type { InsightRule } from "./InsightRule.ts";

export const GetInsightRuleReportHttp = Layer.effect(
  GetInsightRuleReport,
  makeCloudWatchResourceHttpBinding({
    tag: "AWS.CloudWatch.GetInsightRuleReport",
    operation: cloudwatch.getInsightRuleReport,
    actions: ["cloudwatch:GetInsightRuleReport"],
    requestKey: "RuleName",
    identifier: (rule: InsightRule) => rule.ruleName,
    resourceArn: (rule: InsightRule) => rule.ruleArn,
  }),
);

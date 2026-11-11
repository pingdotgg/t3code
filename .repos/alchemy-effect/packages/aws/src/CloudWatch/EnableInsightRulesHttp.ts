import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import type { InsightRuleResource } from "./binding-common.ts";
import { makeCloudWatchResourceSetHttpBinding } from "./BindingHttp.ts";
import { EnableInsightRules } from "./EnableInsightRules.ts";

export const EnableInsightRulesHttp = Layer.effect(
  EnableInsightRules,
  makeCloudWatchResourceSetHttpBinding({
    tag: "AWS.CloudWatch.EnableInsightRules",
    operation: cloudwatch.enableInsightRules,
    action: "cloudwatch:EnableInsightRules",
    namesKey: "RuleNames",
    name: (rule: InsightRuleResource) => rule.ruleName,
    arn: (rule: InsightRuleResource) => rule.ruleArn,
  }),
);

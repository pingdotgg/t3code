import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import type { InsightRuleResource } from "./binding-common.ts";
import { makeCloudWatchResourceSetHttpBinding } from "./BindingHttp.ts";
import { DisableInsightRules } from "./DisableInsightRules.ts";

export const DisableInsightRulesHttp = Layer.effect(
  DisableInsightRules,
  makeCloudWatchResourceSetHttpBinding({
    tag: "AWS.CloudWatch.DisableInsightRules",
    operation: cloudwatch.disableInsightRules,
    action: "cloudwatch:DisableInsightRules",
    namesKey: "RuleNames",
    name: (rule: InsightRuleResource) => rule.ruleName,
    arn: (rule: InsightRuleResource) => rule.ruleArn,
  }),
);

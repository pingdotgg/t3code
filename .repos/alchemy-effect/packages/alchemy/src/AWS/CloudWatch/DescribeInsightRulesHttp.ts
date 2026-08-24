import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeInsightRules } from "./DescribeInsightRules.ts";

export const DescribeInsightRulesHttp = Layer.effect(
  DescribeInsightRules,
  makeCloudWatchAccountHttpBinding({
    tag: "AWS.CloudWatch.DescribeInsightRules",
    operation: cloudwatch.describeInsightRules,
    actions: ["cloudwatch:DescribeInsightRules"],
  }),
);

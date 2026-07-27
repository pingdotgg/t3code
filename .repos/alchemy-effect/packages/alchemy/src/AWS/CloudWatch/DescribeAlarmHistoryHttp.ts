import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeAlarmHistory } from "./DescribeAlarmHistory.ts";

export const DescribeAlarmHistoryHttp = Layer.effect(
  DescribeAlarmHistory,
  makeCloudWatchAccountHttpBinding({
    tag: "AWS.CloudWatch.DescribeAlarmHistory",
    operation: cloudwatch.describeAlarmHistory,
    actions: ["cloudwatch:DescribeAlarmHistory"],
  }),
);

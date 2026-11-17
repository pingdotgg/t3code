import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import type { AlarmResource } from "./binding-common.ts";
import { makeCloudWatchResourceHttpBinding } from "./BindingHttp.ts";
import { DescribeAlarmContributors } from "./DescribeAlarmContributors.ts";

export const DescribeAlarmContributorsHttp = Layer.effect(
  DescribeAlarmContributors,
  makeCloudWatchResourceHttpBinding({
    tag: "AWS.CloudWatch.DescribeAlarmContributors",
    operation: cloudwatch.describeAlarmContributors,
    actions: ["cloudwatch:DescribeAlarmContributors"],
    requestKey: "AlarmName",
    identifier: (alarm: AlarmResource) => alarm.alarmName,
    resourceArn: (alarm: AlarmResource) => alarm.alarmArn,
  }),
);

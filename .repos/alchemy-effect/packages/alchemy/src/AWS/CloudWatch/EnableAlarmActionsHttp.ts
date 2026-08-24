import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import type { AlarmResource } from "./binding-common.ts";
import { makeCloudWatchResourceSetHttpBinding } from "./BindingHttp.ts";
import { EnableAlarmActions } from "./EnableAlarmActions.ts";

export const EnableAlarmActionsHttp = Layer.effect(
  EnableAlarmActions,
  makeCloudWatchResourceSetHttpBinding({
    tag: "AWS.CloudWatch.EnableAlarmActions",
    operation: cloudwatch.enableAlarmActions,
    action: "cloudwatch:EnableAlarmActions",
    namesKey: "AlarmNames",
    name: (alarm: AlarmResource) => alarm.alarmName,
    arn: (alarm: AlarmResource) => alarm.alarmArn,
  }),
);

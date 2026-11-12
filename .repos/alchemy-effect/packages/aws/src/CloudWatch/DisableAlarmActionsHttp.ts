import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import type { AlarmResource } from "./binding-common.ts";
import { makeCloudWatchResourceSetHttpBinding } from "./BindingHttp.ts";
import { DisableAlarmActions } from "./DisableAlarmActions.ts";

export const DisableAlarmActionsHttp = Layer.effect(
  DisableAlarmActions,
  makeCloudWatchResourceSetHttpBinding({
    tag: "AWS.CloudWatch.DisableAlarmActions",
    operation: cloudwatch.disableAlarmActions,
    action: "cloudwatch:DisableAlarmActions",
    namesKey: "AlarmNames",
    name: (alarm: AlarmResource) => alarm.alarmName,
    arn: (alarm: AlarmResource) => alarm.alarmArn,
  }),
);

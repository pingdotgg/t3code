import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import type { AlarmResource } from "./binding-common.ts";
import { makeCloudWatchResourceHttpBinding } from "./BindingHttp.ts";
import { SetAlarmState } from "./SetAlarmState.ts";

export const SetAlarmStateHttp = Layer.effect(
  SetAlarmState,
  makeCloudWatchResourceHttpBinding({
    tag: "AWS.CloudWatch.SetAlarmState",
    operation: cloudwatch.setAlarmState,
    actions: ["cloudwatch:SetAlarmState"],
    requestKey: "AlarmName",
    identifier: (alarm: AlarmResource) => alarm.alarmName,
    resourceArn: (alarm: AlarmResource) => alarm.alarmArn,
  }),
);

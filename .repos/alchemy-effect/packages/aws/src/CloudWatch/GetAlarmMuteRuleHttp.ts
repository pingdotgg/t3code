import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import type { AlarmMuteRule } from "./AlarmMuteRule.ts";
import { makeCloudWatchResourceHttpBinding } from "./BindingHttp.ts";
import { GetAlarmMuteRule } from "./GetAlarmMuteRule.ts";

export const GetAlarmMuteRuleHttp = Layer.effect(
  GetAlarmMuteRule,
  makeCloudWatchResourceHttpBinding({
    tag: "AWS.CloudWatch.GetAlarmMuteRule",
    operation: cloudwatch.getAlarmMuteRule,
    actions: ["cloudwatch:GetAlarmMuteRule"],
    requestKey: "AlarmMuteRuleName",
    identifier: (rule: AlarmMuteRule) => rule.alarmMuteRuleName,
    resourceArn: (rule: AlarmMuteRule) => rule.alarmMuteRuleArn,
  }),
);

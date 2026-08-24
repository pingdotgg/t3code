import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchAccountHttpBinding } from "./BindingHttp.ts";
import { ListAlarmMuteRules } from "./ListAlarmMuteRules.ts";

export const ListAlarmMuteRulesHttp = Layer.effect(
  ListAlarmMuteRules,
  makeCloudWatchAccountHttpBinding({
    tag: "AWS.CloudWatch.ListAlarmMuteRules",
    operation: cloudwatch.listAlarmMuteRules,
    actions: ["cloudwatch:ListAlarmMuteRules"],
  }),
);

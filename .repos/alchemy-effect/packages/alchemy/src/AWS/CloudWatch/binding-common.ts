import type { Alarm } from "./Alarm.ts";
import type { AlarmMuteRule } from "./AlarmMuteRule.ts";
import type { CompositeAlarm } from "./CompositeAlarm.ts";
import type { Dashboard } from "./Dashboard.ts";
import type { InsightRule } from "./InsightRule.ts";
import type { MetricStream } from "./MetricStream.ts";
import { sortByLogicalId } from "./common.ts";

export type AlarmResource = Alarm | CompositeAlarm;

export type InsightRuleResource = InsightRule;

export type TaggableResource =
  | AlarmResource
  | Dashboard
  | MetricStream
  | InsightRule
  | AlarmMuteRule;

export const sortAlarmResources = (
  alarms: [AlarmResource, ...AlarmResource[]],
) => sortByLogicalId(alarms) as [AlarmResource, ...AlarmResource[]];

export const sortInsightRuleResources = (
  rules: [InsightRuleResource, ...InsightRuleResource[]],
) => sortByLogicalId(rules) as [InsightRuleResource, ...InsightRuleResource[]];

export const getTaggableResourceArn = (resource: TaggableResource) => {
  switch (resource.Type) {
    case "AWS.CloudWatch.Alarm":
    case "AWS.CloudWatch.CompositeAlarm":
      return resource.alarmArn;
    case "AWS.CloudWatch.Dashboard":
      return resource.dashboardArn;
    case "AWS.CloudWatch.MetricStream":
      return resource.metricStreamArn;
    case "AWS.CloudWatch.InsightRule":
      return resource.ruleArn;
    case "AWS.CloudWatch.AlarmMuteRule":
      return resource.alarmMuteRuleArn;
  }
};

import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { type AlarmResource, sortAlarmResources } from "./binding-common.ts";
import { DescribeAlarms, type DescribeAlarmsRequest } from "./DescribeAlarms.ts";

export const DescribeAlarmsHttp = Layer.effect(
  DescribeAlarms,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const describeAlarms = yield* AWSBindings.withCredentials(cloudwatch.describeAlarms);

    return Effect.fn(function* (...alarms: AlarmResources) {
      const sorted = sortAlarmResources(alarms);
      const AlarmNames = yield* Effect.forEach(sorted, (alarm) => alarm.alarmName.asEffect());
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.CloudWatch.DescribeAlarms(${sorted})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["cloudwatch:DescribeAlarms"],
              // AWS requires "*" here to return composite alarms.
              Resource: ["*"],
            },
          ],
        });
      }

      return Effect.fn(
        `AWS.CloudWatch.DescribeAlarms(${sorted.map((alarm) => alarm.LogicalId).join(", ")})`,
      )(function* (request: DescribeAlarmsRequest = {}) {
        return yield* describeAlarms({
          ...request,
          AlarmTypes: getAlarmTypes(sorted),
          AlarmNames: yield* Effect.forEach(AlarmNames, (alarmName) => alarmName),
        });
      });
    });
  }),
);

type AlarmResources = [AlarmResource, ...AlarmResource[]];

const getAlarmTypes = (alarms: AlarmResources) =>
  [
    ...new Set(
      alarms.map((alarm) =>
        alarm.Type === "AWS.CloudWatch.CompositeAlarm" ? "CompositeAlarm" : "MetricAlarm",
      ),
    ),
  ] as cloudwatch.AlarmType[];

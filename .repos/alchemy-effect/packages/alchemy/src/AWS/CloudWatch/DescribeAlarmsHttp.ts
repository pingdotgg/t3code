import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isBindingHost } from "../Lambda/Function.ts";
import { type AlarmResource, sortAlarmResources } from "./binding-common.ts";
import {
  DescribeAlarms,
  type DescribeAlarmsRequest,
} from "./DescribeAlarms.ts";

export const DescribeAlarmsHttp = Layer.effect(
  DescribeAlarms,
  Effect.gen(function* () {
    const describeAlarms = yield* cloudwatch.describeAlarms;

    return Effect.fn(function* (...alarms: AlarmResources) {
      const sorted = sortAlarmResources(alarms);
      const AlarmNames = yield* Effect.forEach(sorted, (alarm) =>
        alarm.alarmName.asEffect(),
      );
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.DescribeAlarms(${sorted}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:DescribeAlarms"],
                  // AWS requires "*" here to return composite alarms.
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }

      return Effect.fn(`AWS.CloudWatch.DescribeAlarms(${sorted})`)(function* (
        request: DescribeAlarmsRequest = {},
      ) {
        return yield* describeAlarms({
          ...request,
          AlarmTypes: getAlarmTypes(sorted),
          AlarmNames: yield* Effect.forEach(
            AlarmNames,
            (alarmName) => alarmName,
          ),
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
        alarm.Type === "AWS.CloudWatch.CompositeAlarm"
          ? "CompositeAlarm"
          : "MetricAlarm",
      ),
    ),
  ] as cloudwatch.AlarmType[];

import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import { type AlarmResource, sortAlarmResources } from "./binding-common.ts";

export interface DescribeAlarmsRequest extends Omit<
  cloudwatch.DescribeAlarmsInput,
  "AlarmNames"
> {}

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

/**
 * Runtime binding for `cloudwatch:DescribeAlarms`.
 */
export class DescribeAlarms extends Binding.Service<
  DescribeAlarms,
  (
    ...alarms: AlarmResources
  ) => Effect.Effect<
    (
      request?: DescribeAlarmsRequest,
    ) => Effect.Effect<cloudwatch.DescribeAlarmsOutput, any>
  >
>()("AWS.CloudWatch.DescribeAlarms") {}

export const DescribeAlarmsLive = Layer.effect(
  DescribeAlarms,
  Effect.gen(function* () {
    const Policy = yield* DescribeAlarmsPolicy;
    const describeAlarms = yield* cloudwatch.describeAlarms;

    return Effect.fn(function* (...alarms: AlarmResources) {
      const sorted = sortAlarmResources(alarms);
      const AlarmNames = yield* Effect.forEach(sorted, (alarm) =>
        alarm.alarmName.asEffect(),
      );
      yield* Policy(...sorted);

      return Effect.fn(function* (request: DescribeAlarmsRequest = {}) {
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

export class DescribeAlarmsPolicy extends Binding.Policy<
  DescribeAlarmsPolicy,
  (...alarms: AlarmResources) => Effect.Effect<void>
>()("AWS.CloudWatch.DescribeAlarms") {}

export const DescribeAlarmsPolicyLive = DescribeAlarmsPolicy.layer.succeed(
  Effect.fn(function* (host, ...alarms: AlarmResources) {
    const sorted = sortAlarmResources(alarms);
    if (isFunction(host)) {
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
    } else {
      return yield* Effect.die(
        `DescribeAlarmsPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

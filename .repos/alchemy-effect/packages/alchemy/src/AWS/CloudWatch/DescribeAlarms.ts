import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AlarmResource } from "./binding-common.ts";

export interface DescribeAlarmsRequest extends Omit<
  cloudwatch.DescribeAlarmsInput,
  "AlarmNames"
> {}

type AlarmResources = [AlarmResource, ...AlarmResource[]];

/**
 * Runtime binding for `cloudwatch:DescribeAlarms` — read the current state
 * and configuration of the bound alarms. Bind it to one or more
 * {@link Alarm} / {@link CompositeAlarm} resources; the alarm names are
 * injected automatically.
 *
 * Provide `CloudWatch.DescribeAlarmsHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Reading Alarm State
 * @example Read the State of a Bound Alarm
 * ```typescript
 * const alarm = yield* CloudWatch.Alarm("HighErrors", {
 *   MetricName: "Errors",
 *   Namespace: "AWS/Lambda",
 *   Statistic: "Sum",
 *   Period: 60,
 *   EvaluationPeriods: 1,
 *   Threshold: 1,
 *   ComparisonOperator: "GreaterThanOrEqualToThreshold",
 * });
 *
 * // init — grants cloudwatch:DescribeAlarms on the alarm
 * const describeAlarms = yield* AWS.CloudWatch.DescribeAlarms(alarm);
 *
 * // runtime
 * const result = yield* describeAlarms();
 * const state = result.MetricAlarms?.[0]?.StateValue; // "OK" | "ALARM" | ...
 * ```
 */
export interface DescribeAlarms extends Binding.Service<
  DescribeAlarms,
  "AWS.CloudWatch.DescribeAlarms",
  (
    ...alarms: AlarmResources
  ) => Effect.Effect<
    (
      request?: DescribeAlarmsRequest,
    ) => Effect.Effect<cloudwatch.DescribeAlarmsOutput, any>
  >
> {}

export const DescribeAlarms = Binding.Service<DescribeAlarms>(
  "AWS.CloudWatch.DescribeAlarms",
);

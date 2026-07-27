import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeAlarmHistoryRequest
  extends cloudwatch.DescribeAlarmHistoryInput {}

/**
 * Runtime binding for `cloudwatch:DescribeAlarmHistory` — read state
 * transitions and configuration changes recorded for alarms in the
 * account/region.
 *
 * Provide `CloudWatch.DescribeAlarmHistoryHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Alarm State
 * @example Read an Alarm's Recent History
 * ```typescript
 * // init — grants cloudwatch:DescribeAlarmHistory
 * const describeAlarmHistory = yield* AWS.CloudWatch.DescribeAlarmHistory();
 *
 * // runtime
 * const result = yield* describeAlarmHistory({
 *   AlarmName: yield* alarm.alarmName,
 *   MaxRecords: 10,
 * });
 * const items = result.AlarmHistoryItems ?? [];
 * ```
 */
export interface DescribeAlarmHistory extends Binding.Service<
  DescribeAlarmHistory,
  "AWS.CloudWatch.DescribeAlarmHistory",
  () => Effect.Effect<
    (
      request?: DescribeAlarmHistoryRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeAlarmHistoryOutput,
      cloudwatch.DescribeAlarmHistoryError
    >
  >
> {}

export const DescribeAlarmHistory = Binding.Service<DescribeAlarmHistory>(
  "AWS.CloudWatch.DescribeAlarmHistory",
);

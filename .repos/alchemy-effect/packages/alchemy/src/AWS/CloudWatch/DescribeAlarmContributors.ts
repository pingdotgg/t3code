import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AlarmResource } from "./binding-common.ts";

export interface DescribeAlarmContributorsRequest extends Omit<
  cloudwatch.DescribeAlarmContributorsInput,
  "AlarmName"
> {}

/**
 * Runtime binding for `cloudwatch:DescribeAlarmContributors` — list the
 * time-series contributors currently in ALARM for a contributor-enabled
 * metric-math alarm. Bind it to the {@link Alarm}; the alarm name is
 * injected automatically.
 *
 * Provide `CloudWatch.DescribeAlarmContributorsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Alarm State
 * @example List an Alarm's Contributors
 * ```typescript
 * // init — grants cloudwatch:DescribeAlarmContributors on the alarm
 * const describeAlarmContributors =
 *   yield* AWS.CloudWatch.DescribeAlarmContributors(alarm);
 *
 * // runtime — plain metric alarms have no contributor data; the typed
 * // errors let you treat that as an empty result
 * const contributors = yield* describeAlarmContributors().pipe(
 *   Effect.map((r) => r.AlarmContributors ?? []),
 *   Effect.catchTag(
 *     ["ResourceNotFoundException", "ValidationException"],
 *     () => Effect.succeed([]),
 *   ),
 * );
 * ```
 */
export interface DescribeAlarmContributors extends Binding.Service<
  DescribeAlarmContributors,
  "AWS.CloudWatch.DescribeAlarmContributors",
  (
    alarm: AlarmResource,
  ) => Effect.Effect<
    (
      request?: DescribeAlarmContributorsRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeAlarmContributorsOutput,
      cloudwatch.DescribeAlarmContributorsError
    >
  >
> {}

export const DescribeAlarmContributors =
  Binding.Service<DescribeAlarmContributors>(
    "AWS.CloudWatch.DescribeAlarmContributors",
  );

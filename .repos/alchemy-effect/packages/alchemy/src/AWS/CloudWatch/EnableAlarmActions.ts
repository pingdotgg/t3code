import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AlarmResource } from "./binding-common.ts";

type AlarmResources = [AlarmResource, ...AlarmResource[]];

/**
 * Runtime binding for `cloudwatch:EnableAlarmActions` — re-enable the
 * actions of the bound alarms after they were suppressed with
 * {@link DisableAlarmActions}. Bind it to one or more {@link Alarm} /
 * {@link CompositeAlarm} resources; the alarm names are injected
 * automatically.
 *
 * Provide `CloudWatch.EnableAlarmActionsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Managing Alarm Actions
 * @example Re-enable an Alarm After a Deploy
 * ```typescript
 * // init — grants cloudwatch:EnableAlarmActions on the alarm
 * const enableAlarmActions = yield* AWS.CloudWatch.EnableAlarmActions(alarm);
 *
 * // runtime
 * yield* enableAlarmActions();
 * ```
 */
export interface EnableAlarmActions extends Binding.Service<
  EnableAlarmActions,
  "AWS.CloudWatch.EnableAlarmActions",
  (
    ...alarms: AlarmResources
  ) => Effect.Effect<
    () => Effect.Effect<cloudwatch.EnableAlarmActionsResponse, any>
  >
> {}

export const EnableAlarmActions = Binding.Service<EnableAlarmActions>(
  "AWS.CloudWatch.EnableAlarmActions",
);

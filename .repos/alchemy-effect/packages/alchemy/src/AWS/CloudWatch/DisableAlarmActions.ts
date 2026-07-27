import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AlarmResource } from "./binding-common.ts";

type AlarmResources = [AlarmResource, ...AlarmResource[]];

/**
 * Runtime binding for `cloudwatch:DisableAlarmActions` — suppress the
 * actions of the bound alarms (e.g. during a deploy or maintenance
 * window). Bind it to one or more {@link Alarm} / {@link CompositeAlarm}
 * resources; the alarm names are injected automatically. Re-enable with
 * {@link EnableAlarmActions}.
 *
 * Provide `CloudWatch.DisableAlarmActionsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Managing Alarm Actions
 * @example Mute an Alarm During a Deploy
 * ```typescript
 * // init — grants cloudwatch:DisableAlarmActions on the alarm
 * const disableAlarmActions = yield* AWS.CloudWatch.DisableAlarmActions(alarm);
 *
 * // runtime
 * yield* disableAlarmActions();
 * ```
 */
export interface DisableAlarmActions extends Binding.Service<
  DisableAlarmActions,
  "AWS.CloudWatch.DisableAlarmActions",
  (
    ...alarms: AlarmResources
  ) => Effect.Effect<
    () => Effect.Effect<cloudwatch.DisableAlarmActionsResponse, any>
  >
> {}

export const DisableAlarmActions = Binding.Service<DisableAlarmActions>(
  "AWS.CloudWatch.DisableAlarmActions",
);

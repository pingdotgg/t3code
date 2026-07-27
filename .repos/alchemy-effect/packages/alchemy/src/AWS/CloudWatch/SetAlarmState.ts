import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AlarmResource } from "./binding-common.ts";

export interface SetAlarmStateRequest extends Omit<
  cloudwatch.SetAlarmStateInput,
  "AlarmName"
> {}

/**
 * Runtime binding for `cloudwatch:SetAlarmState` — force the bound alarm
 * into a specific state (useful for testing alarm actions or resetting a
 * stuck alarm). Bind it to an {@link Alarm} / {@link CompositeAlarm}; the
 * alarm name is injected automatically.
 *
 * Provide `CloudWatch.SetAlarmStateHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Managing Alarm Actions
 * @example Force an Alarm into ALARM to Test Its Actions
 * ```typescript
 * // init — grants cloudwatch:SetAlarmState on the alarm
 * const setAlarmState = yield* AWS.CloudWatch.SetAlarmState(alarm);
 *
 * // runtime
 * yield* setAlarmState({
 *   StateValue: "ALARM",
 *   StateReason: "fire-drill: verifying the on-call page",
 * });
 * ```
 */
export interface SetAlarmState extends Binding.Service<
  SetAlarmState,
  "AWS.CloudWatch.SetAlarmState",
  (
    alarm: AlarmResource,
  ) => Effect.Effect<
    (
      request: SetAlarmStateRequest,
    ) => Effect.Effect<
      cloudwatch.SetAlarmStateResponse,
      cloudwatch.SetAlarmStateError
    >
  >
> {}

export const SetAlarmState = Binding.Service<SetAlarmState>(
  "AWS.CloudWatch.SetAlarmState",
);

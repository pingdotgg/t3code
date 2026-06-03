import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { AlarmResource } from "./binding-common.ts";

export interface SetAlarmStateRequest extends Omit<
  cloudwatch.SetAlarmStateInput,
  "AlarmName"
> {}

/**
 * Runtime binding for `cloudwatch:SetAlarmState`.
 */
export class SetAlarmState extends Binding.Service<
  SetAlarmState,
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
>()("AWS.CloudWatch.SetAlarmState") {}

export const SetAlarmStateLive = Layer.effect(
  SetAlarmState,
  Effect.gen(function* () {
    const Policy = yield* SetAlarmStatePolicy;
    const setAlarmState = yield* cloudwatch.setAlarmState;

    return Effect.fn(function* (alarm: AlarmResource) {
      const AlarmName = yield* alarm.alarmName;
      yield* Policy(alarm);

      return Effect.fn(function* (request: SetAlarmStateRequest) {
        return yield* setAlarmState({
          ...request,
          AlarmName: yield* AlarmName,
        });
      });
    });
  }),
);

export class SetAlarmStatePolicy extends Binding.Policy<
  SetAlarmStatePolicy,
  (alarm: AlarmResource) => Effect.Effect<void>
>()("AWS.CloudWatch.SetAlarmState") {}

export const SetAlarmStatePolicyLive = SetAlarmStatePolicy.layer.succeed(
  Effect.fn(function* (host, alarm) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.CloudWatch.SetAlarmState(${alarm}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["cloudwatch:SetAlarmState"],
            Resource: [alarm.alarmArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `SetAlarmStatePolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

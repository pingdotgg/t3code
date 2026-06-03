import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import { type AlarmResource, sortAlarmResources } from "./binding-common.ts";

type AlarmResources = [AlarmResource, ...AlarmResource[]];

/**
 * Runtime binding for `cloudwatch:DisableAlarmActions`.
 */
export class DisableAlarmActions extends Binding.Service<
  DisableAlarmActions,
  (
    ...alarms: AlarmResources
  ) => Effect.Effect<
    () => Effect.Effect<cloudwatch.DisableAlarmActionsResponse, any>
  >
>()("AWS.CloudWatch.DisableAlarmActions") {}

export const DisableAlarmActionsLive = Layer.effect(
  DisableAlarmActions,
  Effect.gen(function* () {
    const Policy = yield* DisableAlarmActionsPolicy;
    const disableAlarmActions = yield* cloudwatch.disableAlarmActions;

    return Effect.fn(function* (...alarms: AlarmResources) {
      const sorted = sortAlarmResources(alarms);
      const AlarmNames = yield* Effect.forEach(sorted, (alarm) =>
        alarm.alarmName.asEffect(),
      );
      yield* Policy(...sorted);

      return Effect.fn(function* () {
        return yield* disableAlarmActions({
          AlarmNames: yield* Effect.forEach(
            AlarmNames,
            (alarmName) => alarmName,
          ),
        });
      });
    });
  }),
);

export class DisableAlarmActionsPolicy extends Binding.Policy<
  DisableAlarmActionsPolicy,
  (...alarms: AlarmResources) => Effect.Effect<void>
>()("AWS.CloudWatch.DisableAlarmActions") {}

export const DisableAlarmActionsPolicyLive =
  DisableAlarmActionsPolicy.layer.succeed(
    Effect.fn(function* (host, ...alarms: AlarmResources) {
      const sorted = sortAlarmResources(alarms);
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.DisableAlarmActions(${sorted}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:DisableAlarmActions"],
                Resource: sorted.map((alarm) => alarm.alarmArn),
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `DisableAlarmActionsPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

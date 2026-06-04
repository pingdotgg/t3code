import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import { type AlarmResource, sortAlarmResources } from "./binding-common.ts";

type AlarmResources = [AlarmResource, ...AlarmResource[]];

/**
 * Runtime binding for `cloudwatch:EnableAlarmActions`.
 */
export class EnableAlarmActions extends Binding.Service<
  EnableAlarmActions,
  (
    ...alarms: AlarmResources
  ) => Effect.Effect<
    () => Effect.Effect<cloudwatch.EnableAlarmActionsResponse, any>
  >
>()("AWS.CloudWatch.EnableAlarmActions") {}

export const EnableAlarmActionsLive = Layer.effect(
  EnableAlarmActions,
  Effect.gen(function* () {
    const Policy = yield* EnableAlarmActionsPolicy;
    const enableAlarmActions = yield* cloudwatch.enableAlarmActions;

    return Effect.fn(function* (...alarms: AlarmResources) {
      const sorted = sortAlarmResources(alarms);
      const AlarmNames = yield* Effect.forEach(sorted, (alarm) =>
        alarm.alarmName.asEffect(),
      );
      yield* Policy(...sorted);

      return Effect.fn(function* () {
        return yield* enableAlarmActions({
          AlarmNames: yield* Effect.forEach(
            AlarmNames,
            (alarmName) => alarmName,
          ),
        });
      });
    });
  }),
);

export class EnableAlarmActionsPolicy extends Binding.Policy<
  EnableAlarmActionsPolicy,
  (...alarms: AlarmResources) => Effect.Effect<void>
>()("AWS.CloudWatch.EnableAlarmActions") {}

export const EnableAlarmActionsPolicyLive =
  EnableAlarmActionsPolicy.layer.succeed(
    Effect.fn(function* (host, ...alarms: AlarmResources) {
      const sorted = sortAlarmResources(alarms);
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.EnableAlarmActions(${sorted}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:EnableAlarmActions"],
                Resource: sorted.map((alarm) => alarm.alarmArn),
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `EnableAlarmActionsPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

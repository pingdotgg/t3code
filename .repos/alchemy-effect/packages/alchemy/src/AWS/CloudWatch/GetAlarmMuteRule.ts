import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { AlarmMuteRule } from "./AlarmMuteRule.ts";

export interface GetAlarmMuteRuleRequest extends Omit<
  cloudwatch.GetAlarmMuteRuleInput,
  "AlarmMuteRuleName"
> {}

/**
 * Runtime binding for `cloudwatch:GetAlarmMuteRule`.
 */
export class GetAlarmMuteRule extends Binding.Service<
  GetAlarmMuteRule,
  (
    rule: AlarmMuteRule,
  ) => Effect.Effect<
    (
      request?: GetAlarmMuteRuleRequest,
    ) => Effect.Effect<
      cloudwatch.GetAlarmMuteRuleOutput,
      cloudwatch.GetAlarmMuteRuleError
    >
  >
>()("AWS.CloudWatch.GetAlarmMuteRule") {}

export const GetAlarmMuteRuleLive = Layer.effect(
  GetAlarmMuteRule,
  Effect.gen(function* () {
    const Policy = yield* GetAlarmMuteRulePolicy;
    const getAlarmMuteRule = yield* cloudwatch.getAlarmMuteRule;

    return Effect.fn(function* (rule: AlarmMuteRule) {
      const AlarmMuteRuleName = yield* rule.alarmMuteRuleName;
      yield* Policy(rule);

      return Effect.fn(function* (request: GetAlarmMuteRuleRequest = {}) {
        return yield* getAlarmMuteRule({
          ...request,
          AlarmMuteRuleName: yield* AlarmMuteRuleName,
        });
      });
    });
  }),
);

export class GetAlarmMuteRulePolicy extends Binding.Policy<
  GetAlarmMuteRulePolicy,
  (rule: AlarmMuteRule) => Effect.Effect<void>
>()("AWS.CloudWatch.GetAlarmMuteRule") {}

export const GetAlarmMuteRulePolicyLive = GetAlarmMuteRulePolicy.layer.succeed(
  Effect.fn(function* (host, rule) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.CloudWatch.GetAlarmMuteRule(${rule}))`(
        {
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["cloudwatch:GetAlarmMuteRule"],
              Resource: [rule.alarmMuteRuleArn],
            },
          ],
        },
      );
    } else {
      return yield* Effect.die(
        `GetAlarmMuteRulePolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

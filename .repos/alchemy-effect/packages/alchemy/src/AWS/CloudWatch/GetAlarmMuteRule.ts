import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AlarmMuteRule } from "./AlarmMuteRule.ts";

export interface GetAlarmMuteRuleRequest extends Omit<
  cloudwatch.GetAlarmMuteRuleInput,
  "AlarmMuteRuleName"
> {}

/**
 * Runtime binding for `cloudwatch:GetAlarmMuteRule` — read the
 * configuration of the bound {@link AlarmMuteRule}; the rule name is
 * injected automatically.
 *
 * Provide `CloudWatch.GetAlarmMuteRuleHttp` on the hosting Lambda Function
 * to satisfy the requirement.
 * @binding
 * @section Reading Mute Rules
 * @example Read a Bound Mute Rule
 * ```typescript
 * // init — grants cloudwatch:GetAlarmMuteRule on the rule
 * const getAlarmMuteRule = yield* AWS.CloudWatch.GetAlarmMuteRule(muteRule);
 *
 * // runtime
 * const result = yield* getAlarmMuteRule();
 * const schedule = result.Rule?.Schedule;
 * ```
 */
export interface GetAlarmMuteRule extends Binding.Service<
  GetAlarmMuteRule,
  "AWS.CloudWatch.GetAlarmMuteRule",
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
> {}

export const GetAlarmMuteRule = Binding.Service<GetAlarmMuteRule>(
  "AWS.CloudWatch.GetAlarmMuteRule",
);

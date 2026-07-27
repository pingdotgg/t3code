import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListAlarmMuteRulesRequest
  extends cloudwatch.ListAlarmMuteRulesInput {}

/**
 * Runtime binding for `cloudwatch:ListAlarmMuteRules` — list the alarm
 * mute rules in the account/region.
 *
 * Provide `CloudWatch.ListAlarmMuteRulesHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Mute Rules
 * @example List Alarm Mute Rules
 * ```typescript
 * // init — grants cloudwatch:ListAlarmMuteRules
 * const listAlarmMuteRules = yield* AWS.CloudWatch.ListAlarmMuteRules();
 *
 * // runtime
 * const result = yield* listAlarmMuteRules();
 * const summaries = result.AlarmMuteRuleSummaries ?? [];
 * ```
 */
export interface ListAlarmMuteRules extends Binding.Service<
  ListAlarmMuteRules,
  "AWS.CloudWatch.ListAlarmMuteRules",
  () => Effect.Effect<
    (
      request?: ListAlarmMuteRulesRequest,
    ) => Effect.Effect<
      cloudwatch.ListAlarmMuteRulesOutput,
      cloudwatch.ListAlarmMuteRulesError
    >
  >
> {}

export const ListAlarmMuteRules = Binding.Service<ListAlarmMuteRules>(
  "AWS.CloudWatch.ListAlarmMuteRules",
);

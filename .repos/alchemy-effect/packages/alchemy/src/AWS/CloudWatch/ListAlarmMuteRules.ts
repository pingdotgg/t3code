import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface ListAlarmMuteRulesRequest
  extends cloudwatch.ListAlarmMuteRulesInput {}

/**
 * Runtime binding for `cloudwatch:ListAlarmMuteRules`.
 */
export class ListAlarmMuteRules extends Binding.Service<
  ListAlarmMuteRules,
  () => Effect.Effect<
    (
      request?: ListAlarmMuteRulesRequest,
    ) => Effect.Effect<
      cloudwatch.ListAlarmMuteRulesOutput,
      cloudwatch.ListAlarmMuteRulesError
    >
  >
>()("AWS.CloudWatch.ListAlarmMuteRules") {}

export const ListAlarmMuteRulesLive = Layer.effect(
  ListAlarmMuteRules,
  Effect.gen(function* () {
    const Policy = yield* ListAlarmMuteRulesPolicy;
    const listAlarmMuteRules = yield* cloudwatch.listAlarmMuteRules;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request: ListAlarmMuteRulesRequest = {}) {
        return yield* listAlarmMuteRules(request);
      });
    });
  }),
);

export class ListAlarmMuteRulesPolicy extends Binding.Policy<
  ListAlarmMuteRulesPolicy,
  () => Effect.Effect<void>
>()("AWS.CloudWatch.ListAlarmMuteRules") {}

export const ListAlarmMuteRulesPolicyLive =
  ListAlarmMuteRulesPolicy.layer.succeed(
    Effect.fn(function* (host) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.ListAlarmMuteRules())`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["cloudwatch:ListAlarmMuteRules"],
              Resource: ["*"],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `ListAlarmMuteRulesPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import {
  sortInsightRuleResources,
  type InsightRuleResource,
} from "./binding-common.ts";

type InsightRules = [InsightRuleResource, ...InsightRuleResource[]];

/**
 * Runtime binding for `cloudwatch:DisableInsightRules`.
 */
export class DisableInsightRules extends Binding.Service<
  DisableInsightRules,
  (
    ...rules: InsightRules
  ) => Effect.Effect<
    () => Effect.Effect<cloudwatch.DisableInsightRulesOutput, any>
  >
>()("AWS.CloudWatch.DisableInsightRules") {}

export const DisableInsightRulesLive = Layer.effect(
  DisableInsightRules,
  Effect.gen(function* () {
    const Policy = yield* DisableInsightRulesPolicy;
    const disableInsightRules = yield* cloudwatch.disableInsightRules;

    return Effect.fn(function* (...rules: InsightRules) {
      const sorted = sortInsightRuleResources(rules);
      const RuleNames = yield* Effect.forEach(sorted, (rule) =>
        rule.ruleName.asEffect(),
      );
      yield* Policy(...sorted);

      return Effect.fn(function* () {
        return yield* disableInsightRules({
          RuleNames: yield* Effect.forEach(RuleNames, (ruleName) => ruleName),
        });
      });
    });
  }),
);

export class DisableInsightRulesPolicy extends Binding.Policy<
  DisableInsightRulesPolicy,
  (...rules: InsightRules) => Effect.Effect<void>
>()("AWS.CloudWatch.DisableInsightRules") {}

export const DisableInsightRulesPolicyLive =
  DisableInsightRulesPolicy.layer.succeed(
    Effect.fn(function* (host, ...rules: InsightRules) {
      const sorted = sortInsightRuleResources(rules);
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.DisableInsightRules(${sorted}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:DisableInsightRules"],
                Resource: sorted.map((rule) => rule.ruleArn),
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `DisableInsightRulesPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

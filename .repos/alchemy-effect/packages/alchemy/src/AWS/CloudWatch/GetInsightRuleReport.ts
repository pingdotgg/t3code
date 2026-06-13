import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { InsightRule } from "./InsightRule.ts";

export interface GetInsightRuleReportRequest extends Omit<
  cloudwatch.GetInsightRuleReportInput,
  "RuleName"
> {}

/**
 * Runtime binding for `cloudwatch:GetInsightRuleReport`.
 */
export class GetInsightRuleReport extends Binding.Service<
  GetInsightRuleReport,
  (
    rule: InsightRule,
  ) => Effect.Effect<
    (
      request: GetInsightRuleReportRequest,
    ) => Effect.Effect<
      cloudwatch.GetInsightRuleReportOutput,
      cloudwatch.GetInsightRuleReportError
    >
  >
>()("AWS.CloudWatch.GetInsightRuleReport") {}

export const GetInsightRuleReportLive = Layer.effect(
  GetInsightRuleReport,
  Effect.gen(function* () {
    const Policy = yield* GetInsightRuleReportPolicy;
    const getInsightRuleReport = yield* cloudwatch.getInsightRuleReport;

    return Effect.fn(function* (rule: InsightRule) {
      const RuleName = yield* rule.ruleName;
      yield* Policy(rule);

      return Effect.fn(function* (request: GetInsightRuleReportRequest) {
        return yield* getInsightRuleReport({
          ...request,
          RuleName: yield* RuleName,
        });
      });
    });
  }),
);

export class GetInsightRuleReportPolicy extends Binding.Policy<
  GetInsightRuleReportPolicy,
  (rule: InsightRule) => Effect.Effect<void>
>()("AWS.CloudWatch.GetInsightRuleReport") {}

export const GetInsightRuleReportPolicyLive =
  GetInsightRuleReportPolicy.layer.succeed(
    Effect.fn(function* (host, rule) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.GetInsightRuleReport(${rule}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:GetInsightRuleReport"],
                Resource: [rule.ruleArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `GetInsightRuleReportPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

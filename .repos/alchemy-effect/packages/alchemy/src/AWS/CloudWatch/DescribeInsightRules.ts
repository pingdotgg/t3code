import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface DescribeInsightRulesRequest
  extends cloudwatch.DescribeInsightRulesInput {}

/**
 * Runtime binding for `cloudwatch:DescribeInsightRules`.
 */
export class DescribeInsightRules extends Binding.Service<
  DescribeInsightRules,
  () => Effect.Effect<
    (
      request?: DescribeInsightRulesRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeInsightRulesOutput,
      cloudwatch.DescribeInsightRulesError
    >
  >
>()("AWS.CloudWatch.DescribeInsightRules") {}

export const DescribeInsightRulesLive = Layer.effect(
  DescribeInsightRules,
  Effect.gen(function* () {
    const Policy = yield* DescribeInsightRulesPolicy;
    const describeInsightRules = yield* cloudwatch.describeInsightRules;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request: DescribeInsightRulesRequest = {}) {
        return yield* describeInsightRules(request);
      });
    });
  }),
);

export class DescribeInsightRulesPolicy extends Binding.Policy<
  DescribeInsightRulesPolicy,
  () => Effect.Effect<void>
>()("AWS.CloudWatch.DescribeInsightRules") {}

export const DescribeInsightRulesPolicyLive =
  DescribeInsightRulesPolicy.layer.succeed(
    Effect.fn(function* (host) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.DescribeInsightRules())`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:DescribeInsightRules"],
                Resource: ["*"],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `DescribeInsightRulesPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

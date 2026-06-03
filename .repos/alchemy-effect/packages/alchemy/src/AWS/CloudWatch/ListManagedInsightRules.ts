import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface ListManagedInsightRulesRequest
  extends cloudwatch.ListManagedInsightRulesInput {}

/**
 * Runtime binding for `cloudwatch:ListManagedInsightRules`.
 */
export class ListManagedInsightRules extends Binding.Service<
  ListManagedInsightRules,
  () => Effect.Effect<
    (
      request?: ListManagedInsightRulesRequest,
    ) => Effect.Effect<
      cloudwatch.ListManagedInsightRulesOutput,
      cloudwatch.ListManagedInsightRulesError
    >
  >
>()("AWS.CloudWatch.ListManagedInsightRules") {}

export const ListManagedInsightRulesLive = Layer.effect(
  ListManagedInsightRules,
  Effect.gen(function* () {
    const Policy = yield* ListManagedInsightRulesPolicy;
    const listManagedInsightRules = yield* cloudwatch.listManagedInsightRules;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (
        request: ListManagedInsightRulesRequest = {},
      ) {
        return yield* listManagedInsightRules(request);
      });
    });
  }),
);

export class ListManagedInsightRulesPolicy extends Binding.Policy<
  ListManagedInsightRulesPolicy,
  () => Effect.Effect<void>
>()("AWS.CloudWatch.ListManagedInsightRules") {}

export const ListManagedInsightRulesPolicyLive =
  ListManagedInsightRulesPolicy.layer.succeed(
    Effect.fn(function* (host) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.ListManagedInsightRules())`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:ListManagedInsightRules"],
                Resource: ["*"],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `ListManagedInsightRulesPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

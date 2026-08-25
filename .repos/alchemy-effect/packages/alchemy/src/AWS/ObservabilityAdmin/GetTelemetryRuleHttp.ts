import * as obs from "@distilled.cloud/aws/observabilityadmin";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { GetTelemetryRule } from "./GetTelemetryRule.ts";
import type { TelemetryRule } from "./TelemetryRule.ts";

/**
 * HTTP implementation of {@link GetTelemetryRule}: grants
 * `observabilityadmin:GetTelemetryRule` on the bound rule's ARN and calls
 * the Observability Admin HTTP API with the function's IAM credentials,
 * injecting the rule's name as the `RuleIdentifier`.
 */
export const GetTelemetryRuleHttp = Layer.effect(
  GetTelemetryRule,
  Effect.gen(function* () {
    const getTelemetryRule = yield* obs.getTelemetryRule;

    return Effect.fn(function* (rule: TelemetryRule) {
      const RuleIdentifier = yield* rule.ruleName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ObservabilityAdmin.GetTelemetryRule(${rule}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["observabilityadmin:GetTelemetryRule"],
                  Resource: [rule.ruleArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.ObservabilityAdmin.GetTelemetryRule(${rule.LogicalId})`,
      )(function* () {
        return yield* getTelemetryRule({
          RuleIdentifier: yield* RuleIdentifier,
        });
      });
    });
  }),
);

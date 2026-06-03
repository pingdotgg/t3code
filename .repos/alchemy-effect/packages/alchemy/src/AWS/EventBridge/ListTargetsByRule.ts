import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Rule } from "./Rule.ts";

export interface ListTargetsByRuleRequest extends Omit<
  eventbridge.ListTargetsByRuleRequest,
  "Rule" | "EventBusName"
> {}

export class ListTargetsByRule extends Binding.Service<
  ListTargetsByRule,
  (
    rule: Rule,
  ) => Effect.Effect<
    (
      request?: ListTargetsByRuleRequest,
    ) => Effect.Effect<
      eventbridge.ListTargetsByRuleResponse,
      eventbridge.ListTargetsByRuleError
    >
  >
>()("AWS.EventBridge.ListTargetsByRule") {}

export const ListTargetsByRuleLive = Layer.effect(
  ListTargetsByRule,
  Effect.gen(function* () {
    const Policy = yield* ListTargetsByRulePolicy;
    const listTargetsByRule = yield* eventbridge.listTargetsByRule;

    return Effect.fn(function* (rule: Rule) {
      const RuleName = yield* rule.ruleName;
      const EventBusName = yield* rule.eventBusName;
      yield* Policy(rule);
      return Effect.fn(function* (request?: ListTargetsByRuleRequest) {
        const ruleName = yield* RuleName;
        const eventBusName = yield* EventBusName;
        return yield* listTargetsByRule({
          ...request,
          Rule: ruleName,
          EventBusName: eventBusName !== "default" ? eventBusName : undefined,
        });
      });
    });
  }),
);

export class ListTargetsByRulePolicy extends Binding.Policy<
  ListTargetsByRulePolicy,
  (rule: Rule) => Effect.Effect<void>
>()("AWS.EventBridge.ListTargetsByRule") {}

export const ListTargetsByRulePolicyLive =
  ListTargetsByRulePolicy.layer.succeed(
    Effect.fn(function* (host, rule) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.EventBridge.ListTargetsByRule(${rule}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["events:ListTargetsByRule"],
                Resource: [rule.ruleArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `ListTargetsByRulePolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );

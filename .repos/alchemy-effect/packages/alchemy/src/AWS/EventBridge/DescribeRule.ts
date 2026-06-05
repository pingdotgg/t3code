import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Rule } from "./Rule.ts";

export interface DescribeRuleRequest extends Omit<
  eventbridge.DescribeRuleRequest,
  "Name" | "EventBusName"
> {}

export class DescribeRule extends Binding.Service<
  DescribeRule,
  (
    rule: Rule,
  ) => Effect.Effect<
    (
      request?: DescribeRuleRequest,
    ) => Effect.Effect<
      eventbridge.DescribeRuleResponse,
      eventbridge.DescribeRuleError
    >
  >
>()("AWS.EventBridge.DescribeRule") {}

export const DescribeRuleLive = Layer.effect(
  DescribeRule,
  Effect.gen(function* () {
    const Policy = yield* DescribeRulePolicy;
    const describeRule = yield* eventbridge.describeRule;

    return Effect.fn(function* (rule: Rule) {
      const Name = yield* rule.ruleName;
      const EventBusName = yield* rule.eventBusName;
      yield* Policy(rule);
      return Effect.fn(function* (request?: DescribeRuleRequest) {
        const name = yield* Name;
        const eventBusName = yield* EventBusName;
        return yield* describeRule({
          ...request,
          Name: name,
          EventBusName: eventBusName !== "default" ? eventBusName : undefined,
        });
      });
    });
  }),
);

export class DescribeRulePolicy extends Binding.Policy<
  DescribeRulePolicy,
  (rule: Rule) => Effect.Effect<void>
>()("AWS.EventBridge.DescribeRule") {}

export const DescribeRulePolicyLive = DescribeRulePolicy.layer.succeed(
  Effect.fn(function* (host, rule) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.EventBridge.DescribeRule(${rule}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["events:DescribeRule"],
            Resource: [rule.ruleArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `DescribeRulePolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

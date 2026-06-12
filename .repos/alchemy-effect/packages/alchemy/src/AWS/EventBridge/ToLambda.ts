import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import * as Binding from "../../Binding.ts";
import type { Function as LambdaFunction } from "../Lambda/Function.ts";
import { Permission as LambdaPermission } from "../Lambda/Permission.ts";
import type { EventBus } from "./EventBus.ts";
import { Rule, type RuleProps, type RuleTarget } from "./Rule.ts";

interface EventDescriptor {
  id?: string;
  bus?: EventBus;
  pattern: Record<string, any>;
  props?: Pick<RuleProps, "description" | "state">;
}

export interface LambdaRouteTargetProps extends Pick<
  RuleTarget,
  | "Input"
  | "InputPath"
  | "InputTransformer"
  | "RetryPolicy"
  | "DeadLetterConfig"
> {}

export class ToLambdaPolicy extends Binding.Policy<
  ToLambdaPolicy,
  (
    routeId: string,
    rule: { ruleArn: unknown },
    fn: LambdaFunction,
  ) => Effect.Effect<void>
>()("AWS.EventBridge.ToLambda") {}

export const ToLambdaPolicyLive = ToLambdaPolicy.layer.succeed(
  Effect.fn(function* (_host, routeId, rule, fn) {
    yield* LambdaPermission(`${routeId}${fn.LogicalId}InvokePermission`, {
      action: "lambda:InvokeFunction",
      functionName: fn.functionName,
      principal: "events.amazonaws.com",
      sourceArn: rule.ruleArn as any,
    }).pipe(Effect.asVoid);
  }) as any,
);

export const toLambda = (
  descriptor: EventDescriptor,
  fn: LambdaFunction,
  props: LambdaRouteTargetProps = {},
) =>
  Effect.gen(function* () {
    const routeId =
      descriptor.id ?? createRouteId(descriptor, `${fn.LogicalId}Lambda`);

    const rule = yield* Rule(routeId, {
      description: descriptor.props?.description,
      state: descriptor.props?.state,
      eventBusName: descriptor.bus?.eventBusName,
      eventPattern: descriptor.pattern,
      targets: [
        {
          Id: `${fn.LogicalId}Target`,
          Arn: fn.functionArn as any,
          Input: props.Input,
          InputPath: props.InputPath,
          InputTransformer: props.InputTransformer,
          RetryPolicy: props.RetryPolicy,
          DeadLetterConfig: props.DeadLetterConfig,
        },
      ],
    });

    yield* ToLambdaPolicy.bind(routeId, rule, fn);

    return rule;
  });

const createRouteId = (descriptor: EventDescriptor, suffix: string) =>
  `EventBridge${createHash("sha1")
    .update(
      JSON.stringify({
        bus: descriptor.bus?.LogicalId ?? "default",
        pattern: descriptor.pattern,
        suffix,
      }),
    )
    .digest("hex")
    .slice(0, 10)}`;

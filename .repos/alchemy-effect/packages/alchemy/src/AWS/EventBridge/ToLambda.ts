import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
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

/**
 * Routes matching events from an EventBridge bus to a Lambda function.
 *
 * Creates a {@link Rule} targeting the function and a Lambda permission
 * allowing `events.amazonaws.com` to invoke it. Usually reached through the
 * `events(...)` builder rather than called directly.
 * @binding
 * @example Route Matching Events to a Lambda Function
 * ```typescript
 * yield* AWS.EventBridge.events(bus, { source: ["my.app"] }).toLambda(fn);
 * ```
 *
 * @example Transform the Event Payload Before Invoking
 * ```typescript
 * yield* AWS.EventBridge.events(bus, { source: ["my.app"] }).toLambda(fn, {
 *   InputTransformer: {
 *     InputPathsMap: { orderId: "$.detail.orderId" },
 *     InputTemplate: '{"orderId": <orderId>}',
 *   },
 * });
 * ```
 */
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

    // Deploy-time: grant EventBridge permission to invoke the Lambda. Skipped
    // once running inside the deployed Function by the global guard. The
    // permission is explicitly named, so no Namespace.push is required.
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* LambdaPermission(`${routeId}${fn.LogicalId}InvokePermission`, {
        action: "lambda:InvokeFunction",
        functionName: fn.functionName,
        principal: "events.amazonaws.com",
        sourceArn: rule.ruleArn as any,
      }).pipe(Effect.asVoid);
    }

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

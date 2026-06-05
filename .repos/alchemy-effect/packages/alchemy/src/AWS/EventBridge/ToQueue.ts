import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Queue } from "../SQS/Queue.ts";
import type { EventBus } from "./EventBus.ts";
import { Rule, type RuleProps, type RuleTarget } from "./Rule.ts";

interface EventDescriptor {
  id?: string;
  bus?: EventBus;
  pattern: Record<string, any>;
  props?: Pick<RuleProps, "description" | "state">;
}

export interface QueueRouteTargetProps extends Pick<
  RuleTarget,
  | "Input"
  | "InputPath"
  | "InputTransformer"
  | "RetryPolicy"
  | "DeadLetterConfig"
> {
  sqsParameters?: RuleTarget["SqsParameters"];
}

export class ToQueuePolicy extends Binding.Policy<
  ToQueuePolicy,
  (rule: { ruleArn: unknown }, queue: Queue) => Effect.Effect<void>
>()("AWS.EventBridge.ToQueue") {}

export const ToQueuePolicyLive = ToQueuePolicy.layer.succeed(
  Effect.fn(function* (_host, rule, queue) {
    yield* queue.bind`Allow(${rule}, AWS.EventBridge.toQueue(${queue}))`({
      policyStatements: [
        {
          Effect: "Allow",
          Principal: {
            Service: "events.amazonaws.com",
          },
          Action: ["sqs:SendMessage"],
          Resource: [queue.queueArn as any],
          Condition: {
            ArnEquals: {
              "aws:SourceArn": [rule.ruleArn as any],
            },
          },
        } satisfies PolicyStatement,
      ],
    });
  }),
);

export const toQueue = (
  descriptor: EventDescriptor,
  queue: Queue,
  props: QueueRouteTargetProps = {},
) =>
  Effect.gen(function* () {
    const routeId =
      descriptor.id ?? createRouteId(descriptor, `${queue.LogicalId}Queue`);

    const rule = yield* Rule(routeId, {
      description: descriptor.props?.description,
      state: descriptor.props?.state,
      eventBusName: descriptor.bus?.eventBusName,
      eventPattern: descriptor.pattern,
      targets: [
        {
          Id: `${queue.LogicalId}Target`,
          Arn: queue.queueArn as any,
          Input: props.Input,
          InputPath: props.InputPath,
          InputTransformer: props.InputTransformer,
          RetryPolicy: props.RetryPolicy,
          DeadLetterConfig: props.DeadLetterConfig,
          SqsParameters: props.sqsParameters,
        },
      ],
    });

    yield* ToQueuePolicy.bind(rule, queue);

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

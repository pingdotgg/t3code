import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
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

/**
 * Routes matching events from an EventBridge bus to an SQS queue.
 *
 * Creates a {@link Rule} targeting the queue and binds a queue policy that
 * allows `events.amazonaws.com` to send messages from that rule. Usually
 * reached through the `events(...)` builder rather than called directly.
 * @binding
 * @example Route Matching Events to an SQS Queue
 * ```typescript
 * yield* AWS.EventBridge.events(bus, { source: ["my.app"] }).toQueue(queue);
 * ```
 */
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

    if (!globalThis.__ALCHEMY_RUNTIME__) {
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

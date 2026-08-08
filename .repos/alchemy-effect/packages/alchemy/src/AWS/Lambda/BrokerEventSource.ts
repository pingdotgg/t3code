import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Namespace from "../../Namespace.ts";
import type { Broker } from "../MQ/Broker.ts";
import {
  BrokerEventSource as MQBrokerEventSource,
  type BrokerEventSourceProps,
  type MQEvent,
  type MQMessage,
} from "../MQ/BrokerEventSource.ts";
import { EventSourceMapping } from "./EventSourceMapping.ts";
import * as Lambda from "./Function.ts";

/** Narrow an incoming Lambda event to an Amazon MQ (ActiveMQ/RabbitMQ) event. */
export const isMQEvent = (event: any): event is MQEvent =>
  event?.eventSource === "aws:mq" || event?.eventSource === "aws:rmq";

/** Flatten an MQ event into a flat list of messages across all queues. */
const messagesOf = (event: MQEvent): MQMessage[] =>
  event.eventSource === "aws:mq"
    ? (event.messages ?? [])
    : Object.values(event.rmqMessagesByQueue ?? {}).flat();

/** @binding */
export const BrokerEventSource = Layer.effect(
  MQBrokerEventSource,
  // @ts-expect-error - the impl resolves plan-time services (EventSourceMapping)
  // whereas BrokerEventSourceService erases the requirement channel to `never`.
  // @effect-diagnostics-next-line missingEffectContext:off
  Effect.gen(function* () {
    const host = yield* Lambda.Function;
    const Mapping = yield* EventSourceMapping;

    return Effect.fn(function* <Req = never>(
      broker: Broker,
      props: BrokerEventSourceProps,
      process: (
        stream: Stream.Stream<MQMessage>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      // Deploy-time: grant IAM and create the event-source mapping. Skipped
      // once running inside the deployed Function (the global guard).
      // Namespaced under the host so the mapping's logical identity is stable.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* host.bind`Allow(${host}, AWS.MQ.BrokerEventSource(${broker}))`(
              {
                policyStatements: [
                  {
                    Effect: "Allow",
                    Action: ["mq:DescribeBroker"],
                    Resource: [broker.brokerArn],
                  },
                  {
                    Effect: "Allow",
                    Action: ["secretsmanager:GetSecretValue"],
                    Resource: [props.credentialsSecretArn],
                  },
                  {
                    // MQ event sources run in the broker's VPC; the poller
                    // manages elastic network interfaces on the function's
                    // behalf. These EC2 actions have no resource-level scoping.
                    Effect: "Allow",
                    Action: [
                      "ec2:CreateNetworkInterface",
                      "ec2:DeleteNetworkInterface",
                      "ec2:DescribeNetworkInterfaces",
                      "ec2:DescribeSecurityGroups",
                      "ec2:DescribeSubnets",
                      "ec2:DescribeVpcs",
                    ],
                    Resource: ["*"],
                  },
                ],
              },
            );

            yield* Mapping(`${broker.LogicalId}-EventSource`, {
              functionName: host.functionName,
              eventSourceArn: broker.brokerArn,
              queues: props.queues,
              sourceAccessConfigurations: [
                { Type: "BASIC_AUTH", URI: props.credentialsSecretArn },
              ],
              batchSize: props.batchSize ?? 100,
              maximumBatchingWindow: props.maximumBatchingWindow,
              enabled: props.enabled ?? true,
            });
          }),
        );
      }

      yield* host.listen(
        Effect.gen(function* () {
          return (event: any) => {
            if (isMQEvent(event)) {
              return process(Stream.fromArray(messagesOf(event))).pipe(
                Effect.orDie,
              );
            }
          };
        }),
      );
    });
  }),
);

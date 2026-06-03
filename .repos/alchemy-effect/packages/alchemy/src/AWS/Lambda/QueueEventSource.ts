import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Binding from "../../Binding.ts";
import type { Queue } from "../SQS/Queue.ts";
import {
  QueueEventSource as SQSQueueEventSource,
  type QueueEventSourceProps,
  type SQSRecord,
} from "../SQS/QueueEventSource.ts";
import { EventSourceMapping } from "./EventSourceMapping.ts";
import * as Lambda from "./Function.ts";

export const isSQSEvent = (event: any): event is lambda.SQSEvent =>
  Array.isArray(event?.Records) &&
  event.Records.length > 0 &&
  event.Records[0].eventSource === "aws:sqs";

export const QueueEventSource = Layer.effect(
  SQSQueueEventSource,
  // @ts-expect-error
  Effect.gen(function* () {
    const host = yield* Lambda.Function;
    const Policy = yield* QueueEventSourcePolicy;

    return Effect.fn(function* <StreamReq = never, Req = never>(
      queue: Queue,
      props: QueueEventSourceProps,
      process: (
        stream: Stream.Stream<SQSRecord, never, StreamReq>,
      ) => Effect.Effect<void, never, Req | StreamReq>,
    ) {
      yield* Policy(queue, props);

      yield* host.listen(
        Effect.gen(function* () {
          return (event: any) => {
            if (isSQSEvent(event)) {
              const eff = process(Stream.fromArray(event.Records)).pipe(
                Effect.orDie,
              );
              return eff;
            }
          };
        }),
      );
    });
  }),
);

export class QueueEventSourcePolicy extends Binding.Policy<
  QueueEventSourcePolicy,
  (queue: Queue, props: QueueEventSourceProps) => Effect.Effect<void>
>()("AWS.SQS.QueueEventSourcePolicy") {}

export const QueueEventSourcePolicyLive = QueueEventSourcePolicy.layer.effect(
  Effect.gen(function* () {
    const Mapping = yield* EventSourceMapping;

    return Effect.fn(function* (host, queue, props) {
      if (Lambda.isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.Lambda.QueueEventSource(${queue}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: [
                  "sqs:ReceiveMessage",
                  "sqs:DeleteMessage",
                  "sqs:GetQueueAttributes",
                ],
                Resource: [queue.queueArn],
              },
            ],
          },
        );

        yield* Mapping(`${queue.LogicalId}-EventSource`, {
          functionName: host.functionName,
          eventSourceArn: queue.queueArn,
          batchSize: props.batchSize,
          maximumBatchingWindowInSeconds: props.maximumBatchingWindowInSeconds,
          enabled: true,
        });
      } else {
        return yield* Effect.die(
          new Error(
            `QueueEventSourcePolicy does not support runtime '${host.Type}'`,
          ),
        );
      }
    });
  }),
);

import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Namespace from "../../Namespace.ts";
import type { Queue } from "../SQS/Queue.ts";
import {
  QueueEventSource as SQSQueueEventSource,
  type QueueEventSourceProps,
  type QueueEventSourceService,
  type SQSRecord,
} from "../SQS/QueueEventSource.ts";
import { EventSourceMapping } from "./EventSourceMapping.ts";
import * as Lambda from "./Function.ts";

export const isSQSEvent = (event: any): event is lambda.SQSEvent =>
  Array.isArray(event?.Records) &&
  event.Records.length > 0 &&
  event.Records[0].eventSource === "aws:sqs";

/** @binding */
export const QueueEventSource = Layer.effect(
  SQSQueueEventSource,
  Effect.gen(function* () {
    const host = yield* Lambda.Function;
    const Mapping = yield* EventSourceMapping;

    return Effect.fn(function* <StreamReq = never, Req = never>(
      queue: Queue,
      props: QueueEventSourceProps,
      process: (
        stream: Stream.Stream<SQSRecord, never, StreamReq>,
      ) => Effect.Effect<void, never, Req | StreamReq>,
    ) {
      // Deploy-time: grant IAM and create the event-source mapping. Skipped once
      // running inside the deployed Function (the global guard), where the only
      // work is registering the runtime handler below. Namespaced under the host
      // so the mapping's logical identity matches the previous Binding.Policy.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
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
              maximumBatchingWindow: props.maximumBatchingWindow,
              enabled: true,
            });
          }),
        );
      }

      yield* host.listen(
        Effect.gen(function* () {
          return (event: any) => {
            if (isSQSEvent(event)) {
              return process(Stream.fromArray(event.Records)).pipe(
                Effect.orDie,
              );
            }
          };
        }),
      );
    }) as QueueEventSourceService;
  }),
);

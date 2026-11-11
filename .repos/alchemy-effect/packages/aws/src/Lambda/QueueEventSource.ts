import * as Namespace from "alchemy/Namespace";
import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { processBatch, traceparentLink } from "../internal/EventSourceBatch.ts";
import type { Queue } from "../SQS/Queue.ts";
import {
  QueueEventSource as SQSQueueEventSource,
  type QueueEventSourceProps,
  type QueueEventSourceService,
  type QueueMessagesHandler,
  type SQSBatchResponse,
  type SQSEvent,
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
    const host = yield* Lambda.eventSourceHost("AWS.Lambda.QueueEventSource");
    const Mapping = yield* EventSourceMapping;

    return Effect.fn(function* <E = never, Req = never>(
      queue: Queue,
      props: QueueEventSourceProps,
      process: QueueMessagesHandler<E, Req>,
    ) {
      // Deploy-time: grant IAM and create the event-source mapping. Skipped once
      // running inside the deployed Function (the global guard), where the only
      // work is registering the runtime handler below. Namespaced under the host
      // so the mapping's logical identity matches the previous Binding.Policy.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* host.bind`Allow(${host}, AWS.Lambda.QueueEventSource(${queue}))`({
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
                  Resource: [queue.queueArn],
                },
              ],
            });

            yield* Mapping(`${queue.LogicalId}-EventSource`, {
              functionName: Lambda.qualifiedNameOf(host),
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
              // A failure fails the invocation, so Lambda retries the whole batch.
              return processQueueBatch(event, process).pipe(Effect.orDie);
            }
          };
        }),
      );
    }) as QueueEventSourceService;
  }),
);

/**
 * Run one SQS batch through the user's handler inside a CONSUMER span and
 * normalize its result into Lambda's partial-batch response. A failure
 * propagates so the invocation errors and Lambda retries the whole batch.
 */
const processQueueBatch = <E, Req>(
  event: SQSEvent,
  process: QueueMessagesHandler<E, Req>,
): Effect.Effect<SQSBatchResponse, E, Req> =>
  process(event).pipe(
    Effect.map((response) => response ?? { batchItemFailures: [] }),
    processBatch({
      system: "aws_sqs",
      destination: event.Records[0]?.eventSourceARN.split(":")[5] ?? "unknown",
      count: event.Records.length,
      links: event.Records.flatMap((record) =>
        Option.toArray(traceparentLink(record.messageAttributes?.traceparent?.stringValue)),
      ),
    }),
  );

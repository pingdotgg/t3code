import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { Region } from "@distilled.cloud/aws/Region";
import * as SQS from "../AWS/SQS/index.ts";
import { ServerHost } from "./Process.ts";

export const SQSQueueEventSource = Layer.effect(
  SQS.QueueEventSource,
  Effect.gen(function* () {
    const { run } = yield* ServerHost;
    const region = yield* Region;

    const ReceiveMessage = yield* SQS.ReceiveMessage;
    const DeleteMessageBatch = yield* SQS.DeleteMessageBatch;

    return Effect.fn(function* <StreamReq = never, Req = never>(
      queue: SQS.Queue,
      props: SQS.QueueEventSourceProps,
      process: (
        stream: Stream.Stream<SQS.SQSRecord, never, StreamReq>,
      ) => Effect.Effect<void, never, Req | StreamReq>,
    ) {
      const QueueArn = yield* queue.queueArn;

      const receiveMessage = yield* ReceiveMessage(queue);
      const deleteMessageBatch = yield* DeleteMessageBatch(queue);

      yield* run(
        Effect.forever(
          Effect.gen(function* () {
            const queueArn = yield* QueueArn;
            const result = yield* receiveMessage({
              MaxNumberOfMessages: props.batchSize ?? 10,
              WaitTimeSeconds: props.maximumBatchingWindowInSeconds,
            });

            const messages = result.Messages ?? [];
            if (messages.length === 0) return;

            yield* process(
              Stream.fromArray(
                messages.map((msg) => ({
                  messageId: msg.MessageId!,
                  receiptHandle: msg.ReceiptHandle!,
                  body: msg.Body!,
                  attributes: {
                    ApproximateReceiveCount:
                      msg.Attributes?.ApproximateReceiveCount!,
                    SentTimestamp: msg.Attributes?.SentTimestamp!,
                    SenderId: msg.Attributes?.SenderId!,
                    ApproximateFirstReceiveTimestamp:
                      msg.Attributes?.ApproximateFirstReceiveTimestamp!,
                  },
                  messageAttributes: {},
                  md5OfBody: msg.MD5OfBody!,
                  eventSource: "aws:sqs",
                  eventSourceARN: queueArn,
                  awsRegion: region,
                })),
              ),
            ).pipe(Effect.orDie);

            // TODO(sam): only delete messages that were successfully processed
            yield* deleteMessageBatch({
              Entries: messages.map((msg, i) => ({
                Id: msg.MessageId ?? String(i),
                ReceiptHandle: msg.ReceiptHandle!,
              })),
            });
          }),
        ).pipe(Effect.orDie),
      );
    }) as SQS.QueueEventSourceService;
  }),
);

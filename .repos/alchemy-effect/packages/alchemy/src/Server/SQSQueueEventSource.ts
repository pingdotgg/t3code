import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { AWSEnvironment } from "../AWS/Environment.ts";
import * as SQS from "../AWS/SQS/index.ts";
import { toWireSeconds } from "../Util/Duration.ts";
import { ServerHost } from "./Process.ts";

export const SQSQueueEventSource = Layer.effect(
  SQS.QueueEventSource,
  Effect.gen(function* () {
    const { run } = yield* ServerHost;
    const env = yield* AWSEnvironment;

    const ReceiveMessage = yield* SQS.ReceiveMessage;
    const DeleteMessageBatch = yield* SQS.DeleteMessageBatch;

    return Effect.fn(function* <StreamReq = never, Req = never>(
      queue: SQS.Queue,
      props: SQS.MessagesProps,
      process: (
        stream: Stream.Stream<SQS.SQSRecord, never, StreamReq>,
      ) => Effect.Effect<void, never, Req | StreamReq>,
    ) {
      const QueueArn = yield* queue.queueArn;
      const { region } = yield* env;

      const receiveMessage = yield* ReceiveMessage(queue);
      const deleteMessageBatch = yield* DeleteMessageBatch(queue);

      yield* run(
        Effect.forever(
          Effect.gen(function* () {
            const queueArn = yield* QueueArn;
            const result = yield* receiveMessage({
              MaxNumberOfMessages:
                props.maxNumberOfMessages ?? props.batchSize ?? 10,
              WaitTimeSeconds:
                toWireSeconds(props.waitTime) ??
                toWireSeconds(props.maximumBatchingWindow),
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

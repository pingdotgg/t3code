import { ServerHost } from "alchemy/Runtime/Process";
import { toWireSeconds } from "alchemy/Util/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { processBatch, traceparentLink } from "../internal/EventSourceBatch.ts";
import * as SQS from "../SQS/index.ts";

export const SQSQueueEventSource = Layer.effect(
  SQS.QueueEventSource,
  Effect.gen(function* () {
    const { run } = yield* ServerHost;

    const ReceiveMessage = yield* SQS.ReceiveMessage;
    const DeleteMessageBatch = yield* SQS.DeleteMessageBatch;

    // Cast below: the service type erases `process`'s requirements, so every
    // event source implementation casts its client.
    return Effect.fn(function* <E = never, Req = never>(
      queue: SQS.Queue,
      props: SQS.MessagesProps,
      process: SQS.QueueMessagesHandler<E, Req>,
    ) {
      const QueueArn = yield* queue.queueArn;

      const receiveMessage = yield* ReceiveMessage(queue);
      const deleteMessageBatch = yield* DeleteMessageBatch(queue);

      yield* run(
        Effect.forever(
          Effect.gen(function* () {
            const queueArn = yield* QueueArn;
            const region = queueArn.split(":")[3]!;
            const result = yield* receiveMessage({
              MaxNumberOfMessages: props.maxNumberOfMessages ?? props.batchSize ?? 10,
              MessageAttributeNames: ["All"],
              MessageSystemAttributeNames: ["All"],
              WaitTimeSeconds:
                toWireSeconds(props.waitTime) ?? toWireSeconds(props.maximumBatchingWindow),
            });

            const messages = result.Messages ?? [];
            if (messages.length === 0) return;

            const records: SQS.SQSRecord[] = messages.map((msg) => ({
              messageId: msg.MessageId!,
              receiptHandle: msg.ReceiptHandle!,
              body: msg.Body!,
              attributes: {
                ApproximateReceiveCount: msg.Attributes?.ApproximateReceiveCount!,
                SentTimestamp: msg.Attributes?.SentTimestamp!,
                SenderId: msg.Attributes?.SenderId!,
                ApproximateFirstReceiveTimestamp: msg.Attributes?.ApproximateFirstReceiveTimestamp!,
                ...(msg.Attributes?.MessageGroupId
                  ? { MessageGroupId: msg.Attributes.MessageGroupId }
                  : {}),
                ...(msg.Attributes?.MessageDeduplicationId
                  ? { MessageDeduplicationId: msg.Attributes.MessageDeduplicationId }
                  : {}),
                ...(msg.Attributes?.SequenceNumber
                  ? { SequenceNumber: msg.Attributes.SequenceNumber }
                  : {}),
                ...(msg.Attributes?.AWSTraceHeader
                  ? { AWSTraceHeader: msg.Attributes.AWSTraceHeader }
                  : {}),
              },
              messageAttributes: Object.fromEntries(
                Object.entries(msg.MessageAttributes ?? {}).map(([name, value]) => [
                  name,
                  {
                    dataType: value?.DataType ?? "String",
                    stringValue: value?.StringValue,
                  },
                ]),
              ),
              md5OfBody: msg.MD5OfBody!,
              eventSource: "aws:sqs",
              eventSourceARN: queueArn,
              awsRegion: region,
            }));

            // Same contract as the Lambda event source: the handler's
            // `batchItemFailures` stay on the queue (visible again after the
            // visibility timeout); a failure leaves the whole batch.
            const response = yield* process({ Records: records }).pipe(
              Effect.map((response) => response ?? { batchItemFailures: [] }),
              processBatch({
                system: "aws_sqs",
                destination: queueArn.split(":")[5]!,
                count: records.length,
                links: records.flatMap((record) =>
                  Option.toArray(
                    traceparentLink(record.messageAttributes.traceparent?.stringValue),
                  ),
                ),
              }),
              Effect.exit,
            );
            if (Exit.isFailure(response)) return;

            const failed = new Set(
              response.value.batchItemFailures.map((failure) => failure.itemIdentifier),
            );
            const succeeded = records.filter((record) => !failed.has(record.messageId));
            if (succeeded.length === 0) return;

            yield* deleteMessageBatch({
              Entries: succeeded.map((record) => ({
                Id: record.messageId,
                ReceiptHandle: record.receiptHandle,
              })),
            });
          }),
        ).pipe(Effect.orDie),
      );
    }) as SQS.QueueEventSourceService;
  }),
);

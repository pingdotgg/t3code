import * as AWS from "@alchemy.run/aws";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

// Partial batch failure fixture: messages whose body starts with `fail-` are
// reported in `batchItemFailures` on their first delivery and forwarded on the
// retry; every other message is forwarded on its first delivery. Each body is
// forwarded as `<body>#<receiveCount>`, so the test can see which messages
// Lambda redelivered.
export class PartialFailureFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "PartialFailureFunction",
) {}

export class PartialFailureQueues extends Context.Service<
  PartialFailureQueues,
  {
    source: AWS.SQS.Queue;
    result: AWS.SQS.Queue;
  }
>()("PartialFailureQueues") {}

export const PartialFailureQueuesLive = Layer.effect(
  PartialFailureQueues,
  Effect.gen(function* () {
    // A short visibility timeout so the failed message is redelivered quickly.
    const source = yield* AWS.SQS.Queue("PartialFailureSourceQueue", {
      visibilityTimeout: "10 seconds",
    });
    const result = yield* AWS.SQS.Queue("PartialFailureResultQueue");
    return { source, result };
  }),
);

export default PartialFailureFunction.make(
  {
    main: import.meta.url,
    functionUrl: true,
  },
  Effect.gen(function* () {
    const { source, result } = yield* PartialFailureQueues;
    const sink = yield* AWS.SQS.QueueSink(result);

    yield* AWS.SQS.consumeQueueMessages(
      source,
      { batchSize: 10, maximumBatchingWindow: "3 seconds" },
      Effect.fn(function* (event) {
        const failed = event.Records.filter(
          (record) =>
            record.body.startsWith("fail-") && record.attributes.ApproximateReceiveCount === "1",
        );
        yield* Stream.fromIterable(event.Records).pipe(
          Stream.filter((record) => !failed.includes(record)),
          Stream.map((record) => ({
            MessageBody: `${record.body}#${record.attributes.ApproximateReceiveCount}`,
          })),
          Stream.run(sink),
        );
        return {
          batchItemFailures: failed.map((record) => ({ itemIdentifier: record.messageId })),
        };
      }),
    );

    const sourceQueueUrl = yield* source.queueUrl;
    const sourceQueueArn = yield* source.queueArn;
    const resultQueueUrl = yield* result.queueUrl;

    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({
          ok: true,
          sourceQueueUrl: yield* sourceQueueUrl,
          sourceQueueArn: yield* sourceQueueArn,
          resultQueueUrl: yield* resultQueueUrl,
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(AWS.Lambda.QueueEventSource, AWS.SQS.QueueSinkHttp),
        Layer.mergeAll(AWS.SQS.SendMessageBatchHttp, PartialFailureQueuesLive),
      ),
    ),
  ),
);

import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "event-source-handler.ts");

// End-to-end QueueEventSource fixture: the Lambda consumes messages from a
// source queue via `consumeQueueMessages` and forwards each record body into
// a result queue via `QueueSink`, so the test can observe delivery
// out-of-band (mirrors test/AWS/Kinesis/stream-handler.ts).
export class QueueEventSourceFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "QueueEventSourceFunction",
) {}

export class SourceAndResultQueues extends Context.Service<
  SourceAndResultQueues,
  {
    source: AWS.SQS.Queue;
    result: AWS.SQS.Queue;
  }
>()("SourceAndResultQueues") {}

export const SourceAndResultQueuesLive = Layer.effect(
  SourceAndResultQueues,
  Effect.gen(function* () {
    const source = yield* AWS.SQS.Queue("EventSourceSourceQueue");
    const result = yield* AWS.SQS.Queue("EventSourceResultQueue");
    return { source, result };
  }),
);

export default QueueEventSourceFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const { source, result } = yield* SourceAndResultQueues;
    const sink = yield* AWS.SQS.QueueSink(result);

    yield* AWS.SQS.consumeQueueMessages(source, { batchSize: 10 }, (records) =>
      records.pipe(
        Stream.map((record) => ({ MessageBody: record.body })),
        Stream.run(sink),
        Effect.orDie,
      ),
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
        Layer.mergeAll(AWS.SQS.SendMessageBatchHttp, SourceAndResultQueuesLive),
      ),
    ),
  ),
);

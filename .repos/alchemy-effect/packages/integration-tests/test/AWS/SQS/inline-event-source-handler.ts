import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import path from "pathe";
import { SourceAndResultQueues, SourceAndResultQueuesLive } from "./event-source-handler.ts";

const main = path.resolve(import.meta.dirname, "inline-event-source-handler.ts");

// The inline (non-class) form of `event-source-handler.ts`: the event source
// needs the `Function` host, which the implementation must be able to require.
export default AWS.Lambda.Function(
  "InlineQueueEventSourceFunction",
  { main, functionUrl: true },
  Effect.gen(function* () {
    const { source, result } = yield* SourceAndResultQueues;
    const sink = yield* AWS.SQS.QueueSink(result);

    yield* AWS.SQS.consumeQueueMessages(
      source,
      { batchSize: 10 },
      Effect.fn(function* (event) {
        yield* Stream.fromIterable(event.Records).pipe(
          Stream.map((record) => ({ MessageBody: record.body })),
          Stream.run(sink),
        );
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
        Layer.mergeAll(AWS.SQS.SendMessageBatchHttp, SourceAndResultQueuesLive),
      ),
    ),
  ),
);

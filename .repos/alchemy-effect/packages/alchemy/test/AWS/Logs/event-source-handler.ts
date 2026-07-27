import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "event-source-handler.ts");

// End-to-end LogGroupEventSource fixture: the Lambda consumes log events from
// a source log group via `consumeLogEvents` (which decodes the gzipped/base64
// `awslogs.data` payload) and forwards each decoded message into a result SQS
// queue via `QueueSink`, so the test can observe delivery out-of-band
// (mirrors test/AWS/SQS/event-source-handler.ts).
export class LogGroupEventSourceFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "LogGroupEventSourceFunction",
) {}

export class SourceGroupAndResultQueue extends Context.Service<
  SourceGroupAndResultQueue,
  {
    source: AWS.Logs.LogGroup;
    result: AWS.SQS.Queue;
  }
>()("SourceGroupAndResultQueue") {}

export const SourceGroupAndResultQueueLive = Layer.effect(
  SourceGroupAndResultQueue,
  Effect.gen(function* () {
    const source = yield* AWS.Logs.LogGroup("EventSourceLogGroup", {
      retention: "1 day",
    });
    const result = yield* AWS.SQS.Queue("LogEventsResultQueue");
    return { source, result };
  }),
);

export default LogGroupEventSourceFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { source, result } = yield* SourceGroupAndResultQueue;
    const sink = yield* AWS.SQS.QueueSink(result);

    yield* AWS.Logs.consumeLogEvents(source, { filterPattern: "" }, (events) =>
      events.pipe(
        Stream.map((event) => ({ MessageBody: event.message })),
        Stream.run(sink),
        Effect.orDie,
      ),
    );

    const sourceLogGroupName = yield* source.logGroupName;
    const resultQueueUrl = yield* result.queueUrl;

    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({
          ok: true,
          sourceLogGroupName: yield* sourceLogGroupName,
          resultQueueUrl: yield* resultQueueUrl,
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(AWS.Lambda.LogGroupEventSource, AWS.SQS.QueueSinkHttp),
        Layer.mergeAll(
          AWS.SQS.SendMessageBatchHttp,
          SourceGroupAndResultQueueLive,
        ),
      ),
    ),
  ),
);

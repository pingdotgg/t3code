import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// End-to-end Pipe fixture: an EventBridge Pipe (created at deploy time via
// the `AWS.Pipes.from(...).toLambda(...)` builder, which synthesizes the
// pipes.amazonaws.com execution role) delivers batches from a source SQS
// queue to this Lambda target. The runtime listener forwards each record
// body into a sink queue so the test can observe delivery out-of-band
// (mirrors test/AWS/SQS/event-source-handler.ts).
export class PipeTargetFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "PipeTargetFunction",
) {}

export class PipeQueues extends Context.Service<
  PipeQueues,
  {
    source: AWS.SQS.Queue;
    sink: AWS.SQS.Queue;
  }
>()("PipeQueues") {}

export const PipeQueuesLive = Layer.effect(
  PipeQueues,
  Effect.gen(function* () {
    const source = yield* AWS.SQS.Queue("PipeSourceQueue");
    const sink = yield* AWS.SQS.Queue("PipeSinkQueue");
    return { source, sink };
  }),
);

// EventBridge Pipes invokes a Lambda target with the raw batch: a JSON
// array of source records (NOT the `{ Records: [...] }` Lambda event-source
// envelope). SQS records carry `eventSource: "aws:sqs"`.
const isPipeSqsBatch = (
  event: unknown,
): event is Array<{ body: string; messageId: string }> =>
  Array.isArray(event) &&
  event.length > 0 &&
  (event[0] as { eventSource?: string })?.eventSource === "aws:sqs";

export default PipeTargetFunction.make(
  {
    main: import.meta.url,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { source, sink } = yield* PipeQueues;
    const sendMessage = yield* AWS.SQS.SendMessage(sink);
    const host = yield* AWS.Lambda.Function;

    // Deploy-time: wire the pipe. Skipped at runtime — the deployed Lambda
    // re-executes this init effect but must not touch the deploy plane.
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* AWS.Pipes.from(source, { batchSize: 1 }).toLambda(host);
    }

    // Runtime: forward every pipe-delivered record body into the sink queue.
    yield* host.listen(
      Effect.gen(function* () {
        return (event: unknown) => {
          if (isPipeSqsBatch(event)) {
            return Effect.forEach(
              event,
              (record) => sendMessage({ MessageBody: record.body }),
              { discard: true },
            ).pipe(Effect.orDie);
          }
        };
      }),
    );

    const sourceQueueUrl = yield* source.queueUrl;
    const sinkQueueUrl = yield* sink.queueUrl;

    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({
          ok: true,
          sourceQueueUrl: yield* sourceQueueUrl,
          sinkQueueUrl: yield* sinkQueueUrl,
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(AWS.SQS.SendMessageHttp, PipeQueuesLive)),
  ),
);

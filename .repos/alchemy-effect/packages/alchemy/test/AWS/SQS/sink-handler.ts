import * as AWS from "@/AWS";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "sink-handler.ts");

export class TestQueue extends Context.Service<
  TestQueue,
  { queue: AWS.SQS.Queue }
>()("TestQueue") {}

export const TestQueueLive = Layer.effect(
  TestQueue,
  Effect.gen(function* () {
    const queue = yield* AWS.SQS.Queue("QueueSinkQueue");
    return { queue };
  }),
);

export class QueueSinkFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "QueueSinkFunction",
  {
    main,
    url: true,
  },
) {}

export const QueueSinkFunctionLive = QueueSinkFunction.make(
  Effect.gen(function* () {
    const { queue } = yield* TestQueue;
    const sink = yield* AWS.SQS.QueueSink.bind(queue);
    const queueUrl = yield* queue.queueUrl;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        yield* Console.log(request);
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({
            ok: true,
            queueUrl: yield* queueUrl,
          });
        }

        if (request.method === "POST" && pathname === "/sink") {
          const body = (yield* request.json) as { messages: string[] };

          yield* Stream.fromIterable(body.messages).pipe(Stream.run(sink));

          return yield* HttpServerResponse.json({
            ok: true,
            count: body.messages.length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        Effect.tapError(Console.log),
        Effect.tap(Console.log),
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.text("Internal server error", { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(TestQueueLive, AWS.SQS.QueueSinkLive),
        Layer.mergeAll(AWS.SQS.SendMessageBatchLive),
      ),
    ),
  ),
);
export default QueueSinkFunctionLive;

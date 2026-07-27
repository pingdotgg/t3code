import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "iot-event-source-handler.ts");

// The MQTT topic the rule subscribes to and the fixture publishes to.
export const TOPIC = "alchemy/iot/eventsource";

// End-to-end IoT TopicRuleEventSource fixture. The Lambda:
//   1. Publishes MQTT messages to `TOPIC` via the IoT Publish binding
//      (POST /publish).
//   2. Consumes messages routed back to it by the IoT topic rule
//      (`consumeTopicMessages`) and forwards each into a result SQS queue via
//      QueueSink, so the test can observe delivery out-of-band.
export class IoTEventSourceFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "IoTEventSourceFunction",
) {}

export class ResultQueue extends Context.Service<
  ResultQueue,
  { result: AWS.SQS.Queue }
>()("IoTResultQueue") {}

export const ResultQueueLive = Layer.effect(
  ResultQueue,
  Effect.gen(function* () {
    const result = yield* AWS.SQS.Queue("IoTEventSourceResultQueue");
    return { result };
  }),
);

export default IoTEventSourceFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const { result } = yield* ResultQueue;
    const sink = yield* AWS.SQS.QueueSink(result);
    const publish = yield* AWS.IoT.Publish(TOPIC);

    yield* AWS.IoT.consumeTopicMessages(TOPIC, (messages) =>
      messages.pipe(
        Stream.map((message) => ({ MessageBody: JSON.stringify(message) })),
        Stream.run(sink),
        Effect.orDie,
      ),
    );

    const resultQueueUrl = yield* result.queueUrl;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({
            ok: true,
            resultQueueUrl: yield* resultQueueUrl,
          });
        }

        if (request.method === "POST" && pathname === "/publish") {
          const body = (yield* request.json) as { marker: string };
          yield* publish({
            topic: TOPIC,
            payload: JSON.stringify({ marker: body.marker }),
          });
          return yield* HttpServerResponse.json({ ok: true });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(
          AWS.Lambda.TopicRuleEventSource,
          AWS.SQS.QueueSinkHttp,
          AWS.IoT.PublishHttp,
        ),
        Layer.mergeAll(AWS.SQS.SendMessageBatchHttp, ResultQueueLive),
      ),
    ),
  ),
);

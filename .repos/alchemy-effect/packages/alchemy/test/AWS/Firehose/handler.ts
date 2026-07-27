import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class FirehoseApiFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "FirehoseApiFunction",
) {}

export class BucketAndDeliveryStream extends Context.Service<
  BucketAndDeliveryStream,
  {
    bucket: AWS.S3.Bucket;
    deliveryStream: AWS.Firehose.DeliveryStream;
  }
>()("BucketAndDeliveryStream") {}

export const BucketAndDeliveryStreamLive = Layer.effect(
  BucketAndDeliveryStream,
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("FirehoseFixtureBucket", {
      forceDestroy: true,
    });

    const deliveryStream = yield* AWS.Firehose.DeliveryStream(
      "FixtureDeliveryStream",
      {
        destination: {
          bucketArn: bucket.bucketArn,
          prefix: "records/",
          // Direct S3 supports zero buffering. Keep the binding fixture at
          // zero so end-to-end delivery can be proven inside the normal test
          // budget instead of imposing Firehose's one-minute flush delay.
          bufferingInterval: "0 seconds",
          bufferingSizeInMBs: 1,
        },
        tags: { fixture: "firehose-bindings" },
      },
    );

    return { bucket, deliveryStream };
  }),
);

export const FirehoseApiFunctionLive = FirehoseApiFunction.make(
  {
    main: import.meta.url,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { deliveryStream } = yield* BucketAndDeliveryStream;

    const putRecord = yield* AWS.Firehose.PutRecord(deliveryStream);
    const putRecordBatch = yield* AWS.Firehose.PutRecordBatch(deliveryStream);
    const sink = yield* AWS.Firehose.DeliveryStreamSink(deliveryStream);
    const listDeliveryStreams = yield* AWS.Firehose.ListDeliveryStreams();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/put-record") {
          const body = (yield* request.json) as { data: string };
          return yield* HttpServerResponse.json(
            yield* putRecord({
              Record: { Data: new TextEncoder().encode(`${body.data}\n`) },
            }),
          );
        }

        if (request.method === "POST" && pathname === "/put-record-batch") {
          const body = (yield* request.json) as { records: string[] };
          return yield* HttpServerResponse.json(
            yield* putRecordBatch({
              Records: body.records.map((data) => ({
                Data: new TextEncoder().encode(`${data}\n`),
              })),
            }),
          );
        }

        if (request.method === "GET" && pathname === "/list-streams") {
          return yield* HttpServerResponse.json(
            yield* listDeliveryStreams({ Limit: 100 }),
          );
        }

        if (request.method === "POST" && pathname === "/sink") {
          const body = (yield* request.json) as { records: string[] };
          // Sinks are request-scoped: Stream.run drains fully (including the
          // engine's bounded partial-failure retries) before the handler
          // responds.
          yield* Stream.fromIterable(body.records).pipe(
            Stream.map((data) => ({
              Data: new TextEncoder().encode(`${data}\n`),
            })),
            Stream.run(sink),
          );
          return yield* HttpServerResponse.json({
            ok: true,
            count: body.records.length,
          });
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
        // The sink layer consumes the PutRecordBatch binding, so the op
        // layers are provided *into* the sink group (and merged out for the
        // fetch routes that call them directly).
        Layer.mergeAll(
          AWS.Firehose.DeliveryStreamSinkHttp,
          BucketAndDeliveryStreamLive,
        ),
        Layer.mergeAll(
          AWS.Firehose.PutRecordHttp,
          AWS.Firehose.PutRecordBatchHttp,
          AWS.Firehose.ListDeliveryStreamsHttp,
        ),
      ),
    ),
  ),
  // Re-merge so the deploying Stack can `yield* BucketAndDeliveryStream` and
  // expose the stream/bucket names as deploy-time outputs. Reusing the same
  // `BucketAndDeliveryStreamLive` reference keeps it a single shared pair.
).pipe(Layer.provideMerge(BucketAndDeliveryStreamLive));

export default FirehoseApiFunctionLive;

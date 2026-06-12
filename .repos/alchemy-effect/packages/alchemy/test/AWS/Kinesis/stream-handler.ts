import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class KinesisStreamFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "KinesisStreamFunction",
  {
    main: import.meta.filename,
    url: true,
  },
) {}

export class StreamAndQueue extends Context.Service<
  StreamAndQueue,
  {
    stream: AWS.Kinesis.Stream;
    queue: AWS.SQS.Queue;
  }
>()("StreamAndQueue") {}

export const StreamAndQueueLive = Layer.effect(
  StreamAndQueue,
  Effect.gen(function* () {
    const stream = yield* AWS.Kinesis.Stream("EventSourceStream", {
      streamMode: "PROVISIONED",
      shardCount: 1,
    });
    const queue = yield* AWS.SQS.Queue("KinesisEventSinkQueue");

    return {
      stream,
      queue,
    };
  }),
);
export default KinesisStreamFunction.make(
  Effect.gen(function* () {
    const { stream, queue } = yield* StreamAndQueue;
    const sink = yield* AWS.SQS.QueueSink.bind(queue);

    yield* AWS.Kinesis.records(stream, {
      startingPosition: "LATEST",
      batchSize: 10,
    }).process((records) =>
      records.pipe(
        Stream.map((record) =>
          JSON.stringify({
            partitionKey: record.kinesis.partitionKey,
            data: Buffer.from(record.kinesis.data, "base64").toString("utf8"),
            eventID: record.eventID,
          }),
        ),
        Stream.run(sink),
      ),
    );

    const streamName = yield* stream.streamName;
    const streamArn = yield* stream.streamArn;
    const queueUrl = yield* queue.queueUrl;

    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({
          ok: true,
          streamArn: yield* streamArn,
          streamName: yield* streamName,
          queueUrl: yield* queueUrl,
        });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(AWS.Lambda.StreamEventSource, AWS.SQS.QueueSinkLive),
        Layer.mergeAll(AWS.SQS.SendMessageBatchLive, StreamAndQueueLive),
      ),
    ),
  ),
);

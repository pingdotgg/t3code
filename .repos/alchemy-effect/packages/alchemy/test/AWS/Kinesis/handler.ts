import * as AWS from "@/AWS";
import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class KinesisApiFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "KinesisApiFunction",
) {}

export class StreamAndConsumer extends Context.Service<
  StreamAndConsumer,
  {
    stream: AWS.Kinesis.Stream;
    consumer: AWS.Kinesis.StreamConsumer;
  }
>()("StreamAndConsumer") {}

export const StreamAndConsumerLive = Layer.effect(
  StreamAndConsumer,
  Effect.gen(function* () {
    const stream = yield* AWS.Kinesis.Stream("FixtureStream", {
      streamMode: "PROVISIONED",
      shardCount: 1,
      tags: {
        fixture: "kinesis-bindings",
      },
    });

    const consumer = yield* AWS.Kinesis.StreamConsumer("FixtureConsumer", {
      streamArn: stream.streamArn,
      tags: {
        fixture: "kinesis-bindings",
      },
    });

    return {
      stream,
      consumer,
    };
  }),
);

export const KinesisApiFunctionLive = KinesisApiFunction.make(
  {
    main: import.meta.url,
    url: true,
    // The sink's bounded partial-failure retry can sleep up to ~6s, which
    // exceeds Lambda's 3s default timeout (see PATTERNS §7).
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { stream, consumer } = yield* StreamAndConsumer;

    const describeAccountSettings =
      yield* AWS.Kinesis.DescribeAccountSettings();
    const describeLimits = yield* AWS.Kinesis.DescribeLimits();
    const listStreams = yield* AWS.Kinesis.ListStreams();
    const describeStream = yield* AWS.Kinesis.DescribeStream(stream);
    const describeStreamSummary =
      yield* AWS.Kinesis.DescribeStreamSummary(stream);
    const listShards = yield* AWS.Kinesis.ListShards(stream);
    const getShardIterator = yield* AWS.Kinesis.GetShardIterator(stream);
    const getRecords = yield* AWS.Kinesis.GetRecords(stream);
    const getResourcePolicy = yield* AWS.Kinesis.GetResourcePolicy(stream);
    const listStreamConsumers = yield* AWS.Kinesis.ListStreamConsumers(stream);
    const describeStreamConsumer =
      yield* AWS.Kinesis.DescribeStreamConsumer(consumer);
    const subscribeToShard = yield* AWS.Kinesis.SubscribeToShard(consumer);
    const listTagsForResource = yield* AWS.Kinesis.ListTagsForResource(stream);
    const putRecord = yield* AWS.Kinesis.PutRecord(stream);
    const putRecords = yield* AWS.Kinesis.PutRecords(stream);
    const sink = yield* AWS.Kinesis.StreamSink(stream);
    const splitShard = yield* AWS.Kinesis.SplitShard(stream);
    const mergeShards = yield* AWS.Kinesis.MergeShards(stream);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/account-settings") {
          const response = yield* describeAccountSettings().pipe(
            Effect.match({
              onFailure: (error) => ({
                ok: false as const,
                error:
                  typeof error === "object" && error !== null && "_tag" in error
                    ? (error as { _tag: string })._tag
                    : `${error}`,
              }),
              onSuccess: (value) => ({
                ok: true as const,
                value,
              }),
            }),
          );
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "GET" && pathname === "/limits") {
          const response = yield* describeLimits().pipe(
            Effect.match({
              onFailure: (error) => ({
                ok: false as const,
                error:
                  typeof error === "object" && error !== null && "_tag" in error
                    ? (error as { _tag: string })._tag
                    : `${error}`,
              }),
              onSuccess: (value) => ({
                ok: true as const,
                value,
              }),
            }),
          );
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "GET" && pathname === "/streams") {
          return yield* HttpServerResponse.json(yield* listStreams());
        }

        if (request.method === "GET" && pathname === "/stream") {
          return yield* HttpServerResponse.json(yield* describeStream());
        }

        if (request.method === "GET" && pathname === "/stream-summary") {
          return yield* HttpServerResponse.json(yield* describeStreamSummary());
        }

        if (request.method === "GET" && pathname === "/resource-policy") {
          const response = yield* getResourcePolicy().pipe(
            Effect.match({
              onFailure: (error) => ({
                ok: false as const,
                error:
                  typeof error === "object" && error !== null && "_tag" in error
                    ? (error as { _tag: string })._tag
                    : `${error}`,
              }),
              onSuccess: (value) => ({
                ok: true as const,
                value,
              }),
            }),
          );
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "GET" && pathname === "/shards") {
          return yield* HttpServerResponse.json(yield* listShards());
        }

        if (request.method === "GET" && pathname === "/stream-consumers") {
          return yield* HttpServerResponse.json(yield* listStreamConsumers());
        }

        if (request.method === "GET" && pathname === "/consumer") {
          return yield* HttpServerResponse.json(
            yield* describeStreamConsumer(),
          );
        }

        if (request.method === "GET" && pathname === "/tags") {
          return yield* HttpServerResponse.json(yield* listTagsForResource());
        }

        if (request.method === "POST" && pathname === "/put-record") {
          const body = (yield* request.json) as {
            partitionKey: string;
            data: string;
          };
          return yield* HttpServerResponse.json(
            yield* putRecord({
              PartitionKey: body.partitionKey,
              Data: new TextEncoder().encode(body.data),
            }),
          );
        }

        if (request.method === "POST" && pathname === "/put-records") {
          const body = (yield* request.json) as {
            records: Array<{ partitionKey: string; data: string }>;
          };
          return yield* HttpServerResponse.json(
            yield* putRecords({
              Records: body.records.map((record) => ({
                PartitionKey: record.partitionKey,
                Data: new TextEncoder().encode(record.data),
              })),
            }),
          );
        }

        if (request.method === "POST" && pathname === "/sink") {
          const body = (yield* request.json) as {
            records: Array<{ partitionKey: string; data: string }>;
          };
          yield* Stream.fromIterable(
            body.records.map((record) => ({
              PartitionKey: record.partitionKey,
              Data: new TextEncoder().encode(record.data),
            })),
          ).pipe(Stream.run(sink));
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/iterator") {
          const body = (yield* request.json) as { shardId: string };
          return yield* HttpServerResponse.json(
            yield* getShardIterator({
              ShardId: body.shardId,
              ShardIteratorType: "LATEST",
            }),
          );
        }

        if (request.method === "POST" && pathname === "/records") {
          const body = (yield* request.json) as {
            shardId: string;
            partitionKey: string;
            data: string;
          };

          const iterator = yield* getShardIterator({
            ShardId: body.shardId,
            ShardIteratorType: "LATEST",
          });
          const shardIterator = iterator.ShardIterator;

          if (!shardIterator) {
            return yield* HttpServerResponse.json(
              { error: "No shard iterator returned" },
              { status: 500 },
            );
          }

          yield* putRecord({
            PartitionKey: body.partitionKey,
            Data: new TextEncoder().encode(body.data),
          });

          const result = yield* waitForRecords(getRecords, shardIterator);
          return yield* HttpServerResponse.json({
            records: (result.Records ?? []).map((record) => ({
              partitionKey: record.PartitionKey,
              data: decodeText(record.Data),
            })),
            millisBehindLatest: result.MillisBehindLatest,
          });
        }

        if (request.method === "POST" && pathname === "/split-shard") {
          const body = (yield* request.json) as {
            shardToSplit: string;
            newStartingHashKey: string;
          };
          yield* splitShard({
            ShardToSplit: body.shardToSplit,
            NewStartingHashKey: body.newStartingHashKey,
          });
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/merge-shards") {
          const body = (yield* request.json) as {
            shardToMerge: string;
            adjacentShardToMerge: string;
          };
          yield* mergeShards({
            ShardToMerge: body.shardToMerge,
            AdjacentShardToMerge: body.adjacentShardToMerge,
          });
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/subscribe") {
          const body = (yield* request.json) as { shardId: string };
          const result = yield* subscribeToShard({
            ShardId: body.shardId,
            StartingPosition: {
              Type: "LATEST",
            },
          });
          return yield* HttpServerResponse.json({
            ok: result.EventStream !== undefined,
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
        Layer.mergeAll(AWS.Kinesis.StreamSinkHttp, AWS.Kinesis.PutRecordsHttp),
        Layer.mergeAll(
          AWS.Kinesis.DescribeAccountSettingsHttp,
          AWS.Kinesis.DescribeLimitsHttp,
          AWS.Kinesis.DescribeStreamHttp,
          AWS.Kinesis.DescribeStreamConsumerHttp,
          AWS.Kinesis.DescribeStreamSummaryHttp,
          AWS.Kinesis.GetRecordsHttp,
          AWS.Kinesis.GetResourcePolicyHttp,
          AWS.Kinesis.GetShardIteratorHttp,
          AWS.Kinesis.ListShardsHttp,
          AWS.Kinesis.ListStreamConsumersHttp,
          AWS.Kinesis.ListStreamsHttp,
          AWS.Kinesis.ListTagsForResourceHttp,
          AWS.Kinesis.MergeShardsHttp,
          AWS.Kinesis.PutRecordHttp,
          AWS.Kinesis.PutRecordsHttp,
          AWS.Kinesis.SplitShardHttp,
          AWS.Kinesis.SubscribeToShardHttp,
          StreamAndConsumerLive,
        ),
      ),
    ),
  ),
  // Re-merge so the deploying Stack can `yield* StreamAndConsumer` and expose
  // the stream/consumer names as deploy-time outputs. Reusing the same
  // `StreamAndConsumerLive` reference keeps it a single shared stream/consumer.
).pipe(Layer.provideMerge(StreamAndConsumerLive));

export default KinesisApiFunctionLive;

const decodeText = (value: Uint8Array<ArrayBufferLike>) =>
  new TextDecoder().decode(value);

class RecordsNotReady extends Data.TaggedError("RecordsNotReady") {}

const waitForRecords = (
  getRecords: (
    request: Kinesis.GetRecordsInput,
  ) => Effect.Effect<Kinesis.GetRecordsOutput, Kinesis.GetRecordsError>,
  shardIterator: string,
) =>
  getRecords({
    ShardIterator: shardIterator,
  }).pipe(
    Effect.flatMap((result) =>
      (result.Records?.length ?? 0) > 0
        ? Effect.succeed(result)
        : Effect.fail(new RecordsNotReady()),
    ),
    Effect.retry({
      while: (error) => error._tag === "RecordsNotReady",
      schedule: Schedule.max([Schedule.fixed("1 second"), Schedule.recurs(10)]),
    }),
  );

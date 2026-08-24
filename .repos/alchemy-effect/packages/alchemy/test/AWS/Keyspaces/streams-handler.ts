import * as Keyspaces from "@/AWS/Keyspaces";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "streams-handler.ts");

export class KeyspacesStreamsTestFunction extends Lambda.Function<Lambda.Function>()(
  "KeyspacesStreamsTestFunction",
) {}

export default KeyspacesStreamsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const keyspace = yield* Keyspaces.Keyspace("StreamsKs", {
      keyspaceName: "alchemy_streams_test_ks",
    });
    const table = yield* Keyspaces.Table("Orders", {
      keyspaceName: keyspace.keyspaceName,
      tableName: "orders",
      columns: [
        { name: "id", type: "uuid" },
        { name: "total", type: "int" },
      ],
      partitionKeys: ["id"],
      cdcSpecification: {
        status: "ENABLED",
        viewType: "NEW_AND_OLD_IMAGES",
      },
    });

    const streams = yield* Keyspaces.TableStreams(table);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Traverse the table's CDC stream end-to-end: list streams →
        // describe the latest → obtain a TRIM_HORIZON iterator on the first
        // shard → read records (an idle table legitimately returns none).
        if (request.method === "GET" && pathname === "/traverse") {
          const listed = yield* streams.listStreams();
          const latest = [...(listed.streams ?? [])].sort((a, b) =>
            b.streamLabel.localeCompare(a.streamLabel),
          )[0];
          if (!latest) {
            return yield* HttpServerResponse.json(
              { error: "no stream visible yet" },
              { status: 503 },
            );
          }
          const stream = yield* streams.getStream({
            streamArn: latest.streamArn,
          });
          const shardId = stream.shards?.[0]?.shardId;
          let recordCount = -1;
          if (shardId !== undefined) {
            const iterator = yield* streams.getShardIterator({
              streamArn: latest.streamArn,
              shardId,
              shardIteratorType: "TRIM_HORIZON",
            });
            if (iterator.shardIterator !== undefined) {
              const records = yield* streams.getRecords({
                shardIterator: iterator.shardIterator,
              });
              recordCount = records.changeRecords?.length ?? 0;
            }
          }
          return yield* HttpServerResponse.json({
            streamArn: stream.streamArn,
            streamStatus: stream.streamStatus,
            viewType: stream.streamViewType,
            shardCount: stream.shards?.length ?? 0,
            recordCount,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Keyspaces.TableStreamsHttp)),
);

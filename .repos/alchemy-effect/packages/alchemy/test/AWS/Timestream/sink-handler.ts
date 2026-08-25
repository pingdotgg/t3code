import * as Lambda from "@/AWS/Lambda";
import * as Timestream from "@/AWS/Timestream";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "sink-handler.ts");

export class TimestreamSinkFunction extends Lambda.Function<Lambda.Function>()(
  "TimestreamSinkFunction",
) {}

export default TimestreamSinkFunction.make(
  {
    main,
    url: true,
    // The sink drains fully (multiple sequential WriteRecords calls behind
    // endpoint discovery) before the handler returns.
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const database = yield* Timestream.Database("SinkMetrics");
    const table = yield* Timestream.Table("SinkCpu", {
      databaseName: database.databaseName,
      retentionProperties: {
        memoryStoreRetention: "6 hours",
        magneticStoreRetention: "30 days",
      },
    });
    const DatabaseName = yield* database.databaseName;
    const TableName = yield* table.tableName;

    // `commonAttributes` exercises the CommonAttributes path: the measure
    // shape is shared, each record carries only Dimensions/MeasureValue/Time.
    const sink = yield* Timestream.RecordsSink(table, {
      commonAttributes: {
        MeasureName: "cpu",
        MeasureValueType: "DOUBLE",
        TimeUnit: "MILLISECONDS",
      },
    });
    const query = yield* Timestream.Query(table);

    const record = (host: string, value: number, time: number) => ({
      Dimensions: [{ Name: "host", Value: host }],
      MeasureValue: `${value}`,
      Time: `${time}`,
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        // Stream `count` records through the sink. count > 100 proves the
        // sink splits the stream into <=100-record WriteRecords calls.
        if (request.method === "POST" && pathname === "/sink") {
          const body = (yield* request.json) as unknown as {
            host: string;
            count: number;
          };
          const base = Date.now() - body.count * 1_000;
          yield* Stream.fromIterable(
            Array.from({ length: body.count }, (_, i) =>
              record(body.host, i, base + i * 1_000),
            ),
          ).pipe(Stream.run(sink));
          return yield* HttpServerResponse.json({
            ok: true,
            count: body.count,
          });
        }

        // Partial failure: one record with a Time outside the 6h memory-store
        // retention window (magnetic writes are disabled by default) is
        // permanently rejected via RejectedRecordsException; the sink drops
        // it and lands the two valid records around it.
        if (request.method === "POST" && pathname === "/sink-rejects") {
          const body = (yield* request.json) as unknown as { host: string };
          const now = Date.now();
          yield* Stream.fromIterable([
            record(body.host, 1, now - 2_000),
            record(body.host, 2, now - 24 * 60 * 60 * 1_000),
            record(body.host, 3, now - 1_000),
          ]).pipe(Stream.run(sink));
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/count") {
          const host = new URL(request.originalUrl).searchParams.get("host");
          const result = yield* query({
            QueryString: `SELECT COUNT(*) AS c FROM "${DatabaseName}"."${TableName}" WHERE host = '${host}'`,
          });
          return yield* HttpServerResponse.json({ rows: result.Rows });
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
        Layer.mergeAll(Timestream.RecordsSinkHttp, Timestream.QueryHttp),
        Layer.mergeAll(Timestream.WriteRecordsHttp),
      ),
    ),
  ),
);

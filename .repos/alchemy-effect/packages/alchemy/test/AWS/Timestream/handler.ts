import * as Lambda from "@/AWS/Lambda";
import * as Timestream from "@/AWS/Timestream";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class TimestreamTestFunction extends Lambda.Function<Lambda.Function>()(
  "TimestreamTestFunction",
) {}

export default TimestreamTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const database = yield* Timestream.Database("Metrics");
    const table = yield* Timestream.Table("Cpu", {
      databaseName: database.databaseName,
    });
    const DatabaseName = yield* database.databaseName;
    const TableName = yield* table.tableName;

    const writeRecords = yield* Timestream.WriteRecords(table);
    const query = yield* Timestream.Query(table);
    const prepareQuery = yield* Timestream.PrepareQuery(table);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "POST" && pathname === "/write") {
          const body = (yield* request.json) as unknown as {
            host: string;
            value: string;
          };
          const result = yield* writeRecords({
            Records: [
              {
                Dimensions: [{ Name: "host", Value: body.host }],
                MeasureName: "cpu",
                MeasureValue: body.value,
                MeasureValueType: "DOUBLE",
                Time: `${Date.now()}`,
                TimeUnit: "MILLISECONDS",
              },
            ],
          });
          return yield* HttpServerResponse.json({
            recordsIngested: result.RecordsIngested,
          });
        }

        if (request.method === "GET" && pathname === "/prepare") {
          const result = yield* prepareQuery({
            QueryString: `SELECT COUNT(*) AS c FROM "${DatabaseName}"."${TableName}"`,
            ValidateOnly: true,
          });
          return yield* HttpServerResponse.json({
            columns: result.Columns,
          });
        }

        if (request.method === "GET" && pathname === "/query") {
          const result = yield* query({
            QueryString: `SELECT COUNT(*) AS c FROM "${DatabaseName}"."${TableName}"`,
          });
          return yield* HttpServerResponse.json({
            rows: result.Rows,
            columns: result.ColumnInfo,
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
      Layer.mergeAll(
        Timestream.WriteRecordsHttp,
        Timestream.QueryHttp,
        Timestream.PrepareQueryHttp,
      ),
    ),
  ),
);

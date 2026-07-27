import * as AWS from "@/AWS";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "sink-handler.ts");

export class SinkTable extends Context.Service<
  SinkTable,
  { table: AWS.DynamoDB.Table }
>()("SinkTable") {}

export const SinkTableLive = Layer.effect(
  SinkTable,
  Effect.gen(function* () {
    const table = yield* AWS.DynamoDB.Table("TableSinkTable", {
      partitionKey: "pk",
      sortKey: "sk",
      attributes: { pk: "S", sk: "S" },
    });
    return { table };
  }),
);

export class TableSinkFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "TableSinkFunction",
) {}

export const TableSinkFunctionLive = TableSinkFunction.make(
  {
    main,
    url: true,
    // The sink's bounded partial-failure retry can sleep up to ~6s, which
    // exceeds Lambda's 3s default timeout (see PATTERNS §7).
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { table } = yield* SinkTable;
    const sink = yield* AWS.DynamoDB.TableSink(table);
    const tableName = yield* table.tableName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({
            ok: true,
            tableName: yield* tableName,
          });
        }

        if (request.method === "POST" && pathname === "/sink") {
          const body = (yield* request.json) as {
            pk: string;
            puts?: string[];
            deletes?: string[];
          };

          const entries: AWS.DynamoDB.TableSinkEntry[] = [
            ...(body.puts ?? []).map(
              (sk): AWS.DynamoDB.TableSinkEntry => ({
                PutRequest: {
                  Item: {
                    pk: { S: body.pk },
                    sk: { S: sk },
                    data: { S: `payload-${sk}` },
                  },
                },
              }),
            ),
            ...(body.deletes ?? []).map(
              (sk): AWS.DynamoDB.TableSinkEntry => ({
                DeleteRequest: {
                  Key: {
                    pk: { S: body.pk },
                    sk: { S: sk },
                  },
                },
              }),
            ),
          ];

          // The sink is request-scoped: drain fully before responding.
          yield* Stream.fromIterable(entries).pipe(Stream.run(sink));

          return yield* HttpServerResponse.json({
            ok: true,
            count: entries.length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        Effect.tapError(Console.log),
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
        Layer.mergeAll(SinkTableLive, AWS.DynamoDB.TableSinkHttp),
        Layer.mergeAll(AWS.DynamoDB.BatchWriteItemHttp),
      ),
    ),
  ),
);
export default TableSinkFunctionLive;

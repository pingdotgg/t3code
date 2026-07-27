import * as Lambda from "@/AWS/Lambda";
import * as RedshiftData from "@/AWS/RedshiftData";
import * as RedshiftServerless from "@/AWS/RedshiftServerless";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "data-api-handler.ts");

export class RedshiftDataApiFunction extends Lambda.Function<Lambda.Function>()(
  "RedshiftDataApiFunction",
) {}

/** Statement statuses that mean the run is over. */
const isTerminal = (status: string | undefined): boolean =>
  status === "FINISHED" || status === "FAILED" || status === "ABORTED";

/**
 * One route per Data API client behavior, all against the same serverless
 * workgroup (distinct deterministic names from the RedshiftServerless suite
 * so both gated suites can run side by side without fighting over physical
 * names).
 */
export default RedshiftDataApiFunction.make(
  {
    main,
    url: true,
    // Data API statements are submitted then polled; a cold workgroup can
    // take ~30s to serve its first statement — allow generous headroom.
    timeout: Duration.seconds(240),
  },
  Effect.gen(function* () {
    const namespace = yield* RedshiftServerless.Namespace("DataApiNamespace", {
      namespaceName: "alchemy-test-rsd-ns",
      dbName: "dev",
      adminUsername: "alchemyadmin",
      manageAdminPassword: true,
    });
    const workgroup = yield* RedshiftServerless.Workgroup("DataApiWorkgroup", {
      workgroupName: "alchemy-test-rsd-wg",
      namespaceName: namespace.namespaceName,
      baseCapacity: 8,
      publiclyAccessible: false,
    });

    const sql = yield* RedshiftData.Statements(workgroup, { database: "dev" });

    // Poll a submitted statement until it reaches a terminal status
    // (bounded: 45 * 2s = 90s).
    const waitTerminal = (id: string) =>
      sql.describe(id).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (r): boolean => isTerminal(r.Status),
          times: 45,
        }),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method !== "GET") {
          return yield* HttpServerResponse.json(
            { error: "Not found", method: request.method, pathname },
            { status: 404 },
          );
        }

        // execute + describe + getResult via the composite query.
        if (pathname === "/query") {
          const result = yield* sql.query("SELECT 1 AS n");
          return yield* HttpServerResponse.json({
            columns: (result.ColumnMetadata ?? []).map((c) => c.name),
            records: result.Records,
            totalNumRows: result.TotalNumRows,
          });
        }

        // executeBatch + describe (sub-statements) + getResult of a
        // sub-statement.
        if (pathname === "/batch") {
          const submitted = yield* sql.executeBatch({
            Sqls: ["SELECT 1 AS a", "SELECT 2 AS b"],
          });
          const described = yield* waitTerminal(submitted.Id!);
          const subStatements = described.SubStatements ?? [];
          const second = subStatements[1];
          const result =
            described.Status === "FINISHED" && second !== undefined
              ? yield* sql.getResult(second.Id)
              : undefined;
          return yield* HttpServerResponse.json({
            status: described.Status,
            subStatementCount: subStatements.length,
            secondRecords: result?.Records,
          });
        }

        // listDatabases + listSchemas + listTables + describeTable.
        if (pathname === "/metadata") {
          const databases = yield* sql.listDatabases();
          const schemas = yield* sql.listSchemas({
            SchemaPattern: "pg_catalog",
          });
          const tables = yield* sql.listTables({
            SchemaPattern: "pg_catalog",
            TablePattern: "pg_class",
          });
          const table = yield* sql.describeTable({
            Schema: "pg_catalog",
            Table: "pg_class",
          });
          return yield* HttpServerResponse.json({
            databases: databases.Databases,
            schemas: schemas.Schemas,
            tables: (tables.Tables ?? []).map((t) => t.name),
            columnCount: (table.ColumnList ?? []).length,
          });
        }

        // execute + listStatements (statement-owner scoped).
        if (pathname === "/statements") {
          const submitted = yield* sql.execute({ Sql: "SELECT 42 AS answer" });
          yield* waitTerminal(submitted.Id!);
          const listed = yield* sql.listStatements();
          return yield* HttpServerResponse.json({
            count: listed.Statements.length,
            hasSubmitted: listed.Statements.some((s) => s.Id === submitted.Id),
          });
        }

        // execute a heavy statement then cancel it. Cancellation races
        // statement completion — a ValidationException means the statement
        // already finished, which still proves the wiring end to end.
        if (pathname === "/cancel") {
          const submitted = yield* sql.execute({
            Sql: "SELECT count(*) FROM pg_catalog.pg_attribute a CROSS JOIN pg_catalog.pg_attribute b CROSS JOIN pg_catalog.pg_attribute c",
          });
          const canceled = yield* sql.cancel(submitted.Id!).pipe(
            Effect.map((r) => r.Status === true),
            Effect.catchTag("ValidationException", () => Effect.succeed(false)),
          );
          return yield* HttpServerResponse.json({ canceled });
        }

        // execute with ResultFormat CSV + getResultV2.
        if (pathname === "/result-v2") {
          const submitted = yield* sql.execute({
            Sql: "SELECT 7 AS n",
            ResultFormat: "CSV",
          });
          const described = yield* waitTerminal(submitted.Id!);
          const result = yield* sql.getResultV2(submitted.Id!);
          return yield* HttpServerResponse.json({
            status: described.Status,
            resultFormat: result.ResultFormat,
            records: result.Records,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(RedshiftData.StatementsHttp)),
);

import * as Athena from "@/AWS/Athena";
import * as Glue from "@/AWS/Glue";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Output from "@/Output";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Fixed lowercase Glue identifiers so the SQL below is deterministic. The
// bucket and workgroup are engine-named (unique); the database/table/catalog
// are scoped to this single Athena e2e suite.
const DATABASE = "alchemy_athena_e2e";
const TABLE = "people";
const CATALOG = "alchemy_athena_e2e_catalog";
const STATEMENT = "alchemy_athena_e2e_stmt";
const CSV = "1,alice\n2,bob\n3,carol\n";

export class AthenaTestFunction extends Lambda.Function<Lambda.Function>()(
  "AthenaTestFunction",
) {}

export default AthenaTestFunction.make(
  {
    main,
    url: true,
    // startQueryExecution → poll getQueryExecution → getQueryResults fans out
    // several SDK calls; AWS's 3s default would intermittently time out.
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    // Single bucket holds the CSV source data (under data/), the Athena query
    // results (under results/), and the event-source markers (under events/).
    const bucket = yield* S3.Bucket("AthenaBucket", { forceDestroy: true });

    const database = yield* Glue.Database("AthenaDatabase", {
      databaseName: DATABASE,
    });
    yield* Glue.Table("AthenaTable", {
      databaseName: database.databaseName,
      tableName: TABLE,
      tableType: "EXTERNAL_TABLE",
      storageDescriptor: {
        location: Output.interpolate`s3://${bucket.bucketName}/data/`,
        columns: [
          { name: "id", type: "string" },
          { name: "name", type: "string" },
        ],
        inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
        outputFormat:
          "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
        serdeInfo: {
          serializationLibrary:
            "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe",
          parameters: { "field.delim": "," },
        },
      },
    });

    const workGroup = yield* Athena.WorkGroup("AthenaWorkGroup", {
      outputLocation: Output.interpolate`s3://${bucket.bucketName}/results/`,
      enforceWorkGroupConfiguration: true,
    });

    // A GLUE-type data catalog federating to this account's own Glue Data
    // Catalog (catalog-id = the account id, derived from the workgroup ARN)
    // — drives the catalog-metadata bindings against the fixture database.
    const dataCatalog = yield* Athena.DataCatalog("AthenaGlueCatalog", {
      name: CATALOG,
      type: "GLUE",
      parameters: {
        "catalog-id": workGroup.workGroupArn.pipe(
          Output.map((arn) => arn.split(":")[4]!),
        ),
      },
    });

    // Saved-query + prepared-statement fixtures in the workgroup — the
    // ListNamedQueries/ListPreparedStatements bindings enumerate them.
    yield* Athena.NamedQuery("AthenaNamedQuery", {
      queryString: `SELECT * FROM ${TABLE} LIMIT 1`,
      database: DATABASE,
      workGroup: workGroup.workGroupName,
    });
    yield* Athena.PreparedStatement("AthenaPreparedStatement", {
      statementName: STATEMENT,
      queryStatement: `SELECT * FROM ${DATABASE}.${TABLE} WHERE id = ?`,
      workGroup: workGroup.workGroupName,
    });

    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);
    const runQuery = yield* Athena.Query(workGroup, bucket);

    // --- workgroup-scoped query-execution bindings ---
    const getQueryExecution = yield* Athena.GetQueryExecution(workGroup);
    const getQueryResults = yield* Athena.GetQueryResults(workGroup);
    const stopQueryExecution = yield* Athena.StopQueryExecution(workGroup);
    const batchGetQueryExecution =
      yield* Athena.BatchGetQueryExecution(workGroup);
    const listQueryExecutions = yield* Athena.ListQueryExecutions(workGroup);
    const getQueryRuntimeStatistics =
      yield* Athena.GetQueryRuntimeStatistics(workGroup);
    const listNamedQueries = yield* Athena.ListNamedQueries(workGroup);
    const listPreparedStatements =
      yield* Athena.ListPreparedStatements(workGroup);

    // --- catalog-metadata bindings ---
    const listDatabases = yield* Athena.ListDatabases(dataCatalog);
    const getDatabase = yield* Athena.GetDatabase(dataCatalog);
    const listTableMetadata = yield* Athena.ListTableMetadata(dataCatalog);
    const getTableMetadata = yield* Athena.GetTableMetadata(dataCatalog);

    // --- event source ---
    // Athena publishes every query state transition to the default bus; write
    // a marker object per terminal transition so /events/probe can observe
    // the delivery out-of-band (the event may arrive on another instance).
    yield* Athena.consumeQueryStateChanges(
      { states: ["SUCCEEDED", "FAILED", "CANCELLED"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          putObject({
            Key: `events/${event.detail.queryExecutionId}`,
            Body: JSON.stringify(event.detail),
            ContentType: "application/json",
          }).pipe(Effect.orDie, Effect.asVoid),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const param = (name: string) => url.searchParams.get(name) ?? "";

        // Seed the CSV source data into s3://bucket/data/.
        if (request.method === "POST" && pathname === "/seed") {
          yield* putObject({
            Key: "data/rows.csv",
            Body: CSV,
            ContentType: "text/csv",
          });
          return yield* HttpServerResponse.json({ seeded: true });
        }

        // Flagship: run a Glue-backed query end-to-end and read the result.
        if (request.method === "GET" && pathname === "/count") {
          const result = yield* runQuery({
            QueryString: `SELECT COUNT(*) AS c FROM ${DATABASE}.${TABLE}`,
          });
          return yield* HttpServerResponse.json({
            state: result.state,
            columns: result.columns,
            rows: result.rows,
          });
        }

        // Glue-free path: proves start+poll+results without any table.
        if (request.method === "GET" && pathname === "/select-one") {
          const result = yield* runQuery({ QueryString: "SELECT 1" });
          return yield* HttpServerResponse.json({
            state: result.state,
            columns: result.columns,
            rows: result.rows,
          });
        }

        // Run a trivial query to completion and hand back its execution id
        // for the granular query-execution bindings below.
        if (request.method === "GET" && pathname === "/exec/run") {
          const result = yield* runQuery({ QueryString: "SELECT 1" });
          return yield* HttpServerResponse.json({
            id: result.queryExecutionId,
          });
        }

        if (request.method === "GET" && pathname === "/exec/get") {
          const res = yield* getQueryExecution({
            QueryExecutionId: param("id"),
          });
          return yield* HttpServerResponse.json({
            state: res.QueryExecution?.Status?.State,
            workGroup: res.QueryExecution?.WorkGroup,
          });
        }

        if (request.method === "GET" && pathname === "/exec/results") {
          const res = yield* getQueryResults({
            QueryExecutionId: param("id"),
          });
          return yield* HttpServerResponse.json({
            rows: res.ResultSet?.Rows?.length ?? 0,
            columns: (res.ResultSet?.ResultSetMetadata?.ColumnInfo ?? []).map(
              (c) => c.Name,
            ),
          });
        }

        if (request.method === "GET" && pathname === "/exec/stats") {
          // Runtime statistics materialize asynchronously shortly after the
          // query completes — retry briefly.
          const res = yield* getQueryRuntimeStatistics({
            QueryExecutionId: param("id"),
          }).pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "InvalidRequestException",
              schedule: Schedule.spaced("1 second"),
              times: 8,
            }),
          );
          return yield* HttpServerResponse.json({
            totalMillis:
              res.QueryRuntimeStatistics?.Timeline?.TotalExecutionTimeInMillis,
          });
        }

        if (request.method === "GET" && pathname === "/exec/batch") {
          const res = yield* batchGetQueryExecution({
            QueryExecutionIds: [param("id")],
          });
          return yield* HttpServerResponse.json({
            states: (res.QueryExecutions ?? []).map((qe) => qe.Status?.State),
          });
        }

        if (request.method === "GET" && pathname === "/exec/list") {
          const res = yield* listQueryExecutions({ MaxResults: 25 });
          return yield* HttpServerResponse.json({
            ids: res.QueryExecutionIds ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/exec/stop") {
          // Stopping an already-completed query is a documented no-op, which
          // makes this deterministic without racing a long-running query.
          yield* stopQueryExecution({ QueryExecutionId: param("id") });
          return yield* HttpServerResponse.json({ stopped: true });
        }

        if (request.method === "GET" && pathname === "/named/list") {
          const res = yield* listNamedQueries({ MaxResults: 50 });
          return yield* HttpServerResponse.json({
            ids: res.NamedQueryIds ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/prepared/list") {
          const res = yield* listPreparedStatements({ MaxResults: 50 });
          return yield* HttpServerResponse.json({
            names: (res.PreparedStatements ?? []).map((s) => s.StatementName),
          });
        }

        if (request.method === "GET" && pathname === "/catalog/databases") {
          const res = yield* listDatabases({});
          return yield* HttpServerResponse.json({
            names: (res.DatabaseList ?? []).map((db) => db.Name),
          });
        }

        if (request.method === "GET" && pathname === "/catalog/database") {
          const res = yield* getDatabase({ DatabaseName: param("name") });
          return yield* HttpServerResponse.json({
            name: res.Database?.Name,
          });
        }

        if (request.method === "GET" && pathname === "/catalog/tables") {
          const res = yield* listTableMetadata({ DatabaseName: param("db") });
          return yield* HttpServerResponse.json({
            names: (res.TableMetadataList ?? []).map((t) => t.Name),
          });
        }

        if (request.method === "GET" && pathname === "/catalog/table") {
          const res = yield* getTableMetadata({
            DatabaseName: param("db"),
            TableName: param("name"),
          });
          return yield* HttpServerResponse.json({
            columns: (res.TableMetadata?.Columns ?? []).map((c) => c.Name),
          });
        }

        // Run a query, then poll for the event-source marker the state-change
        // handler wrote to S3 (bounded well under the 60s function timeout).
        if (request.method === "GET" && pathname === "/events/probe") {
          const result = yield* runQuery({ QueryString: "SELECT 1" });
          const id = result.queryExecutionId;
          const seen = yield* getObject({ Key: `events/${id}` }).pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "NoSuchKey",
              schedule: Schedule.spaced("2 seconds"),
              times: 12,
            }),
            Effect.map(() => true),
            Effect.catchTag("NoSuchKey", () => Effect.succeed(false)),
          );
          return yield* HttpServerResponse.json({ seen, id });
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
        Lambda.EventSource,
        Athena.QueryHttp,
        Athena.GetQueryExecutionHttp,
        Athena.GetQueryResultsHttp,
        Athena.StopQueryExecutionHttp,
        Athena.BatchGetQueryExecutionHttp,
        Athena.ListQueryExecutionsHttp,
        Athena.GetQueryRuntimeStatisticsHttp,
        Athena.ListNamedQueriesHttp,
        Athena.ListPreparedStatementsHttp,
        Athena.ListDatabasesHttp,
        Athena.GetDatabaseHttp,
        Athena.ListTableMetadataHttp,
        Athena.GetTableMetadataHttp,
        S3.PutObjectHttp,
        S3.GetObjectHttp,
      ),
    ),
  ),
);

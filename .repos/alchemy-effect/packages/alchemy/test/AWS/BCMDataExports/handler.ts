import * as BCMDataExports from "@/AWS/BCMDataExports";
import * as Lambda from "@/AWS/Lambda";
import { Bucket } from "@/AWS/S3/Bucket.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const bucketName = "alchemy-test-bcm-bindings-dest";
export const fixtureExportName = "alchemy-test-bcm-bindings-export";

// A well-formed-but-nonexistent execution id — drives the typed error path
// for GetExecution (a fresh export has no executions to read yet).
const NONEXISTENT_EXECUTION_ID = "00000000-0000-0000-0000-000000000000";

const queryStatement =
  "SELECT identity_line_item_id, identity_time_interval, line_item_unblended_cost FROM COST_AND_USAGE_REPORT";

export class BCMDataExportsTestFunction extends Lambda.Function<Lambda.Function>()(
  "BCMDataExportsTestFunction",
) {}

export default BCMDataExportsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // Destination bucket must let the Data Exports service principals write
    // to it and read its policy.
    const bucket = yield* Bucket("BindingsExportDest", {
      bucketName,
      forceDestroy: true,
      policy: [
        {
          Sid: "EnableAWSDataExportsToWriteToS3AndCheckPolicy",
          Effect: "Allow",
          Principal: {
            Service: [
              "billingreports.amazonaws.com",
              "bcm-data-exports.amazonaws.com",
            ],
          },
          Action: ["s3:PutObject", "s3:GetBucketPolicy"],
          Resource: [
            `arn:aws:s3:::${bucketName}`,
            `arn:aws:s3:::${bucketName}/*`,
          ],
        },
      ],
    });

    const dataExport = yield* BCMDataExports.Export("BindingsExport", {
      exportName: fixtureExportName,
      description: "alchemy bcm-data-exports bindings fixture",
      dataQuery: {
        queryStatement,
        tableConfigurations: {
          COST_AND_USAGE_REPORT: {
            TIME_GRANULARITY: "HOURLY",
            INCLUDE_RESOURCES: "FALSE",
            INCLUDE_MANUAL_DISCOUNT_COMPATIBILITY: "FALSE",
            INCLUDE_SPLIT_COST_ALLOCATION_DATA: "FALSE",
          },
        },
      },
      s3Destination: {
        s3Bucket: bucket.bucketName,
        s3Prefix: "bindings",
        s3Region: "us-east-1",
      },
    });

    // --- export-scoped bindings ---
    const getExport = yield* BCMDataExports.GetExport(dataExport);
    const getExecution = yield* BCMDataExports.GetExecution(dataExport);
    const listExecutions = yield* BCMDataExports.ListExecutions(dataExport);

    // --- account-level bindings ---
    const listExports = yield* BCMDataExports.ListExports();
    const getTable = yield* BCMDataExports.GetTable();
    const listTables = yield* BCMDataExports.ListTables();

    const bound = {
      getExport,
      getExecution,
      listExecutions,
      listExports,
      getTable,
      listTables,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/export") {
          const result = yield* getExport();
          return yield* HttpServerResponse.json({
            name: result.Export?.Name ?? null,
            prefix:
              result.Export?.DestinationConfigurations.S3Destination.S3Prefix ??
              null,
            frequency: result.Export?.RefreshCadence.Frequency ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/exports") {
          const result = yield* listExports({ MaxResults: 100 });
          return yield* HttpServerResponse.json({
            names: (result.Exports ?? []).map((e) => e.ExportName ?? null),
          });
        }

        if (request.method === "GET" && pathname === "/executions") {
          const result = yield* listExecutions({ MaxResults: 25 });
          return yield* HttpServerResponse.json({
            count: (result.Executions ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/execution-not-found") {
          // Exercises `ExportArn` injection + the typed error path — a fresh
          // export has no executions, so the nonexistent id must surface a
          // typed tag (an IAM gap would surface AccessDeniedException and
          // fail the route with an opaque 500 instead).
          const tag = yield* getExecution({
            ExecutionId: NONEXISTENT_EXECUTION_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/table") {
          const result = yield* getTable({
            TableName: "COST_AND_USAGE_REPORT",
          });
          return yield* HttpServerResponse.json({
            tableName: result.TableName ?? null,
            columnCount: (result.Schema ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/tables") {
          const result = yield* listTables({ MaxResults: 100 });
          return yield* HttpServerResponse.json({
            names: (result.Tables ?? []).map((t) => t.TableName ?? null),
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
        BCMDataExports.GetExportHttp,
        BCMDataExports.GetExecutionHttp,
        BCMDataExports.ListExecutionsHttp,
        BCMDataExports.ListExportsHttp,
        BCMDataExports.GetTableHttp,
        BCMDataExports.ListTablesHttp,
      ),
    ),
  ),
);

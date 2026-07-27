import * as Lambda from "@/AWS/Lambda";
import * as S3Tables from "@/AWS/S3Tables";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

export class S3TablesBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "S3TablesBindingsFunction",
) {}

export default S3TablesBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // Deterministic names so a crashed previous run is reconciled (observed
    // and reused) instead of orphaned by a fresh random instance suffix.
    const bucket = yield* S3Tables.TableBucket("BindingsTableBucket", {
      name: "alchemy-s3tables-bindings",
    });
    const namespace = yield* S3Tables.Namespace("BindingsNamespace", {
      tableBucket: bucket.tableBucketArn,
      namespace: "bindings",
    });
    const table = yield* S3Tables.Table("BindingsTable", {
      tableBucket: bucket.tableBucketArn,
      namespace: namespace.namespace,
      name: "events",
      schema: {
        fields: [
          { name: "id", type: "long", required: true },
          { name: "payload", type: "string" },
        ],
      },
    });

    const listNamespaces = yield* S3Tables.ListNamespaces(bucket);
    const listTables = yield* S3Tables.ListTables(bucket);
    const getTable = yield* S3Tables.GetTable(table);
    const getTableMetadataLocation =
      yield* S3Tables.GetTableMetadataLocation(table);
    const updateTableMetadataLocation =
      yield* S3Tables.UpdateTableMetadataLocation(table);
    const getTableMaintenanceJobStatus =
      yield* S3Tables.GetTableMaintenanceJobStatus(table);

    const bound = {
      listNamespaces,
      listTables,
      getTable,
      getTableMetadataLocation,
      updateTableMetadataLocation,
      getTableMaintenanceJobStatus,
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

        if (request.method === "GET" && pathname === "/namespaces") {
          // tableBucketARN injection scopes the listing to the bound bucket.
          const response = yield* listNamespaces();
          return yield* HttpServerResponse.json({
            names: response.namespaces.map((ns) => ns.namespace[0]),
          });
        }

        if (request.method === "GET" && pathname === "/tables") {
          const response = yield* listTables({ namespace: "bindings" });
          return yield* HttpServerResponse.json({
            names: response.tables.map((t) => t.name),
          });
        }

        if (request.method === "GET" && pathname === "/table") {
          const response = yield* getTable();
          return yield* HttpServerResponse.json({
            name: response.name,
            format: response.format,
            versionToken: response.versionToken,
            warehouseLocation: response.warehouseLocation,
          });
        }

        if (request.method === "GET" && pathname === "/metadata-location") {
          const response = yield* getTableMetadataLocation();
          return yield* HttpServerResponse.json({
            versionToken: response.versionToken,
            metadataLocation: response.metadataLocation ?? null,
            warehouseLocation: response.warehouseLocation,
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/metadata-location/commit"
        ) {
          // The Iceberg commit protocol round-trip: read the current version
          // token, then commit a metadata pointer with it. The fixture
          // doesn't write a real Iceberg metadata file, so the service may
          // reject the pointer with a typed BadRequestException — either
          // outcome proves the grant and identifier injection end-to-end (an
          // IAM gap would surface AccessDeniedException as a 500 instead).
          const current = yield* getTableMetadataLocation();
          const result = yield* updateTableMetadataLocation({
            versionToken: current.versionToken,
            metadataLocation: `${current.warehouseLocation}/metadata/00001-alchemy-bindings-test.metadata.json`,
          }).pipe(
            Effect.map((r) => ({
              committed: true,
              errorTag: null as string | null,
              versionTokenChanged: r.versionToken !== current.versionToken,
            })),
            Effect.catchTag(
              ["BadRequestException", "ConflictException", "NotFoundException"],
              (e) =>
                Effect.succeed({
                  committed: false,
                  errorTag: e._tag as string | null,
                  versionTokenChanged: false,
                }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/maintenance-jobs") {
          const response = yield* getTableMaintenanceJobStatus();
          return yield* HttpServerResponse.json({
            tableArn: response.tableARN,
            jobs: Object.keys(response.status),
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
        S3Tables.ListNamespacesHttp,
        S3Tables.ListTablesHttp,
        S3Tables.GetTableHttp,
        S3Tables.GetTableMetadataLocationHttp,
        S3Tables.UpdateTableMetadataLocationHttp,
        S3Tables.GetTableMaintenanceJobStatusHttp,
      ),
    ),
  ),
);

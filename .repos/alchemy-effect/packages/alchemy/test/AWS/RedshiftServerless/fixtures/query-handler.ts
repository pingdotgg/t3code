import * as Lambda from "@/AWS/Lambda";
import * as RedshiftData from "@/AWS/RedshiftData";
import * as RedshiftServerless from "@/AWS/RedshiftServerless";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "query-handler.ts");

export class RedshiftQueryFunction extends Lambda.Function<Lambda.Function>()(
  "RedshiftQueryFunction",
) {}

export default RedshiftQueryFunction.make(
  {
    main,
    url: true,
    // Redshift Data statements are submitted then polled — allow generous
    // time for the composite query to finish.
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    const namespace = yield* RedshiftServerless.Namespace("QueryNamespace", {
      namespaceName: "alchemy-test-rs-ns",
      dbName: "dev",
      adminUsername: "alchemyadmin",
      manageAdminPassword: true,
    });
    const workgroup = yield* RedshiftServerless.Workgroup("QueryWorkgroup", {
      workgroupName: "alchemy-test-rs-wg",
      namespaceName: namespace.namespaceName,
      baseCapacity: 8,
      publiclyAccessible: false,
    });

    const sql = yield* RedshiftData.Statements(workgroup, { database: "dev" });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/query") {
          const result = yield* sql.query("SELECT 1 AS n");
          return yield* HttpServerResponse.json({
            columns: (result.ColumnMetadata ?? []).map((c) => c.name),
            records: result.Records,
            totalNumRows: result.TotalNumRows,
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

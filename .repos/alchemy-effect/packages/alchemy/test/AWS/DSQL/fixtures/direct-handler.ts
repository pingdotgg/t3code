import * as DSQL from "@/AWS/DSQL";
import * as Lambda from "@/AWS/Lambda";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";
import { Db } from "./db.ts";

const main = path.resolve(import.meta.dirname, "direct-handler.ts");

export class DsqlDirectFunction extends Lambda.Function<Lambda.Function>()(
  "DsqlDirectFunction",
) {}

/**
 * Lambda fixture proving the DIRECT public-endpoint path: a raw Postgres
 * client (`@effect/sql-pg`, no Drizzle, no Hyperdrive, no VPC) connects to
 * `<clusterId>.dsql.<region>.on.aws:5432` over TLS with the IAM auth token
 * that `DSQL.Connect` mints as the password.
 */
export default DsqlDirectFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
    // Preserve `pg` as CommonJS in node_modules; bundling it rewrites the
    // Client constructor into a namespace object and crashes Lambda init.
    build: { install: ["pg"] },
  },
  Effect.gen(function* () {
    const cluster = yield* Db;
    const conn = yield* DSQL.Connect(cluster, { admin: true });
    const getVpcEndpointServiceName =
      yield* DSQL.GetVpcEndpointServiceName(cluster);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // PrivateLink service-name lookup via the management binding.
        if (request.method === "GET" && pathname === "/vpc-endpoint-service") {
          const { serviceName, clusterVpcEndpoint } =
            yield* getVpcEndpointServiceName();
          return yield* HttpServerResponse.json({
            serviceName,
            clusterVpcEndpoint: clusterVpcEndpoint ?? null,
          });
        }

        // Connection descriptor shape — no socket opened. The password
        // (auth token) is never echoed, only its presence.
        if (request.method === "GET" && pathname === "/info") {
          const info = yield* conn;
          return yield* HttpServerResponse.json({
            host: info.host,
            port: info.port,
            database: info.database,
            username: info.username,
            hasPassword:
              info.password !== undefined &&
              Redacted.value(info.password).length > 0,
            ssl: info.ssl,
            urlScheme: Redacted.value(info.url).split("://")[0],
          });
        }

        // Full round-trip over the public endpoint: mint token, open a TLS
        // socket, CREATE TABLE / INSERT / SELECT. The pool is built on the
        // per-event scope (`Layer.build` + ambient request Scope), so it is
        // closed when the invocation settles.
        if (request.method === "POST" && pathname === "/roundtrip") {
          const info = yield* conn;
          const ctx = yield* Layer.build(PgClient.layer({ url: info.url }));
          const sqlClient = Context.get(ctx, PgClient.PgClient);
          // DSQL runs DDL as its own autocommit statement (no DDL+DML
          // transactions) — each call below is a separate statement.
          yield* sqlClient`CREATE TABLE IF NOT EXISTS dsql_direct_widgets (id integer PRIMARY KEY, title text NOT NULL)`;
          yield* sqlClient`DELETE FROM dsql_direct_widgets WHERE id = 1`;
          yield* sqlClient`INSERT INTO dsql_direct_widgets (id, title) VALUES (1, 'direct')`;
          const rows =
            yield* sqlClient`SELECT id, title FROM dsql_direct_widgets WHERE id = 1`;
          return yield* HttpServerResponse.json({ rows, host: info.host });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(DSQL.ConnectHttp, DSQL.GetVpcEndpointServiceNameHttp),
    ),
  ),
);

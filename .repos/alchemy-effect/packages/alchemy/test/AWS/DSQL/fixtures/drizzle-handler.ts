import * as DSQL from "@/AWS/DSQL";
import * as Lambda from "@/AWS/Lambda";
import * as Drizzle from "@/Drizzle/index.ts";
import { eq, sql } from "drizzle-orm";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";
import { Db } from "./db.ts";
import { Widgets } from "./schema.ts";

const main = path.resolve(import.meta.dirname, "drizzle-handler.ts");

export class DsqlDrizzleFunction extends Lambda.Function<Lambda.Function>()(
  "DsqlDrizzleFunction",
) {}

/**
 * Lambda fixture proving the full-stack Drizzle-over-DSQL path: the
 * `DSQL.Connect` binding mints an IAM auth token per execution, and
 * `Drizzle.Postgres` builds its execution-scoped pool from the resulting
 * connection URL. No VPC — DSQL's endpoint is public and IAM-gated.
 */
export default DsqlDrizzleFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
    // `pg` is CommonJS and Rolldown's bundled interop turns its Client export
    // into a namespace object under Node. Install it intact in the Lambda
    // artifact so @effect/sql-pg loads the package with Node's CJS semantics.
    build: { install: ["pg"] },
  },
  Effect.gen(function* () {
    const cluster = yield* Db;
    const conn = yield* DSQL.Connect(cluster, { admin: true });
    // `proxyChain` defers the connect to the first query, so the pool (and
    // the IAM token backing it) is built inside the invocation, per
    // execution — a fresh token can never outlive its pool.
    const db = yield* Drizzle.Postgres(
      conn.pipe(Effect.map((info) => info.url)),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness probe — proves connect + token auth end-to-end.
        if (request.method === "GET" && pathname === "/health") {
          // postgres-js `execute()` resolves to the row array itself.
          const rows = yield* db.execute(sql`SELECT 1 AS one`);
          return yield* HttpServerResponse.json({ rows });
        }

        // DSQL runs DDL outside DML transactions; each execute is its own
        // autocommit statement. DELETE (not DROP) keeps reruns fast.
        if (request.method === "POST" && pathname === "/setup") {
          yield* db.execute(
            sql`CREATE TABLE IF NOT EXISTS dsql_connect_widgets (id integer PRIMARY KEY, title text NOT NULL)`,
          );
          yield* db.execute(sql`DELETE FROM dsql_connect_widgets`);
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "POST" && pathname === "/insert") {
          const body = (yield* request.json) as unknown as {
            id: number;
            title: string;
          };
          yield* db.insert(Widgets).values({ id: body.id, title: body.title });
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "GET" && pathname === "/select") {
          const id = url.searchParams.get("id");
          if (!id) {
            return HttpServerResponse.text("Missing id", { status: 400 });
          }
          const rows = yield* db
            .select()
            .from(Widgets)
            .where(eq(Widgets.id, Number(id)));
          return yield* HttpServerResponse.json({ rows });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(DSQL.ConnectHttp)),
);

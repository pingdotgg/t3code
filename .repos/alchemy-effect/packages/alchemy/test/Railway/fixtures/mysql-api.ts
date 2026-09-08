import * as Drizzle from "@/Drizzle/MySQL.ts";
import * as Railway from "@/Railway";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Partition, Site } from "./suite-env.ts";

export const MYSQL_API_PORT = 3000;

export { Site };

export const Db = Railway.MySQL("Db", {
  project: Site,
  environment: Partition,
});

/**
 * HTTP Service that binds MySQL via {@link Railway.ConnectMySQL}
 * and answers SELECT 1. Never returns the connection string.
 */
export default class MySQLApi extends Railway.Service<MySQLApi>()(
  "MySQLApi",
  {
    project: Site,
    environment: Partition,
    main: import.meta.url,
    port: MYSQL_API_PORT,
    build: { install: ["mysql2"] },
  },
  Effect.gen(function* () {
    const conn = yield* Railway.ConnectMySQL(Db);
    const db = yield* Drizzle.MySQL(conn.connectionString);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        if (path === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        const rows = yield* db.execute("select 1 as ok", "objects");
        if (path === "/health" || path === "/") {
          return yield* HttpServerResponse.json({ rows });
        }
        return yield* HttpServerResponse.json({ rows }, { status: 404 });
      }).pipe(
        Effect.catch((error) =>
          HttpServerResponse.json(
            { ok: false, error: String(error) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Railway.ConnectMySQLHttp)),
) {}

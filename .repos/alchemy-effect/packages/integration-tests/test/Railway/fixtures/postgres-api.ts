import * as Drizzle from "@alchemy.run/drizzle/Postgres";
import * as Railway from "@alchemy.run/railway";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Db } from "./postgres-shared.ts";
import { Partition, Site } from "./suite-env.ts";

export { Db, Site };

export const POSTGRES_PORT = 3000;

/**
 * HTTP Service that binds Postgres via {@link Railway.ConnectPostgres}
 * and answers SELECT 1. Never returns the connection string.
 */
export default class PostgresApi extends Railway.Service<PostgresApi>()(
  "PostgresApi",
  {
    project: Site,
    environment: Partition,
    main: import.meta.url,
    port: POSTGRES_PORT,
  },
  Effect.gen(function* () {
    const conn = yield* Railway.ConnectPostgres(Db);
    const db = yield* Drizzle.Postgres(conn.connectionString);

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
          HttpServerResponse.json({ ok: false, error: String(error) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Railway.ConnectPostgresHttp)),
) {}

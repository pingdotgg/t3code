import * as Fly from "@/Fly";
import * as Drizzle from "@/Drizzle/Postgres.ts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const POSTGRES_PORT = 3000;

export const MpgSite = Fly.App("MpgSite", {
  enableSubdomains: true,
});

export const Db = Fly.Postgres("Db", {
  region: "iad",
  plan: "basic",
  volumeSizeGb: 10,
});

export const MpgIp = Fly.IpAssignment("Shared", {
  app: MpgSite,
  type: "shared_v4",
});

/**
 * HTTP Service that binds Managed Postgres via {@link Fly.ConnectPostgres}
 * and answers SELECT 1. Never returns the connection string.
 */
export default class PostgresApi extends Fly.Service<PostgresApi>()(
  "PostgresApi",
  {
    app: MpgSite,
    main: import.meta.url,
    region: "iad",
    port: POSTGRES_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 512 },
    build: { install: ["pg"] },
  },
  Effect.gen(function* () {
    const conn = yield* Fly.ConnectPostgres(Db);
    const db = yield* Drizzle.Postgres(conn.connectionString);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        if (path === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        const result = yield* Effect.result(db.execute("select 1 as ok"));
        if (Result.isFailure(result)) {
          const error = result.failure;
          return yield* HttpServerResponse.json(
            {
              ok: false,
              error:
                error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : String(error),
            },
            { status: 500 },
          );
        }
        const rows = result.success;
        if (path === "/health" || path === "/") {
          return yield* HttpServerResponse.json({ rows });
        }
        return yield* HttpServerResponse.json({ rows }, { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Fly.ConnectPostgresHttp)),
) {}

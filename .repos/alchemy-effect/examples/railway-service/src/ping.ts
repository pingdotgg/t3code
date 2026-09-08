import * as Drizzle from "alchemy/Drizzle/Postgres";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Db, Site } from "./shared.ts";

/**
 * HTTP Service. Canvas Functions cap at 96KB and cannot hold
 * Drizzle/pg; this image is built from `main` like {@link Api}.
 * Binds the same {@link Db} via {@link Railway.ConnectPostgres}.
 */
export default class Ping extends Railway.Service<Ping>()(
  "Ping",
  {
    project: Site,
    main: import.meta.url,
    port: 3000,
    build: { install: ["pg"] },
    healthcheck: "/",
  },
  Effect.gen(function* () {
    const conn = yield* Railway.ConnectPostgres(Db);
    const db = yield* Drizzle.Postgres(conn.connectionString);
    return {
      fetch: db.execute("select 1 as ok").pipe(
        Effect.flatMap(HttpServerResponse.json),
        Effect.catch((error) =>
          HttpServerResponse.json(
            { ok: false, error: String(error) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Railway.ConnectPostgresHttp)),
) {}

import * as Cloudflare from "@/Cloudflare/index.ts";
// Deep imports keep the Worker bundle lean: the `@/Prisma` barrel pulls in
// the local dev-database machinery (@prisma/dev -> pglite), which balloons
// the script and has no business inside a deployed Worker.
import { Connection } from "@/Prisma/Connection.ts";
import type { PostgresOrigin } from "@/Prisma/PostgresOrigin.ts";
import { Postgres } from "@/Prisma/Postgres.ts";
import { Project } from "@/Prisma/Project.ts";
import * as SQL from "@/SQL/Postgres.ts";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Prisma Postgres origin + Hyperdrive wiring shared by the fixture Worker.
 * The Hyperdrive config fronts the direct (non-pooled) Prisma endpoint via
 * `connection.origin`, the same shape Planetscale roles and Neon branches
 * materialize.
 */
export const PrismaDb = Effect.gen(function* () {
  const project = yield* Project("PrismaHyperdriveProject", {
    createDatabase: false,
  });
  const database = yield* Postgres("PrismaHyperdriveDb", {
    project,
  });
  const connection = yield* Connection("PrismaHyperdriveConnection", {
    database,
  });
  return { project, database, connection };
});

export const Hyperdrive = Effect.gen(function* () {
  const { connection } = yield* PrismaDb;
  return yield* Cloudflare.Hyperdrive.Connection("PrismaHyperdriveEdge", {
    origin: connection.origin.as<PostgresOrigin>(),
    // The test asserts read-your-writes across separate HTTP requests;
    // Hyperdrive's query cache (60s default) would serve stale SELECTs.
    caching: { disabled: true },
  });
});

const TABLE = "alchemy_prisma_widgets";

/**
 * Effect-native Worker driving `SQL.Postgres` over a Hyperdrive connection
 * to a Prisma Postgres origin.
 */
export default class PrismaHyperdriveWorker extends Cloudflare.Worker<PrismaHyperdriveWorker>()(
  "PrismaHyperdriveWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const hd = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const sql = yield* SQL.Postgres({ url: hd.connectionString });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "POST" && url.pathname === "/widgets") {
          const body = (yield* request.json) as { id: number; name: string };
          yield* sql`CREATE TABLE IF NOT EXISTS ${sql(TABLE)} (id INT PRIMARY KEY, name TEXT NOT NULL)`;
          yield* sql`INSERT INTO ${sql(TABLE)} (id, name) VALUES (${body.id}, ${body.name}) ON CONFLICT (id) DO UPDATE SET name = ${body.name}`;
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && url.pathname === "/widgets") {
          const widgets =
            yield* sql`SELECT id, name FROM ${sql(TABLE)} ORDER BY id`;
          return yield* HttpServerResponse.json({ widgets });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}

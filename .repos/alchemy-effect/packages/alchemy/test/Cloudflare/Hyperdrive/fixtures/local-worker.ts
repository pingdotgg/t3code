import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as SQL from "@/SQL/Postgres.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Hyperdrive Connection for the local-emulation test: the `dev` origin
 * points at the same real Neon Postgres the live Hyperdrive tests use, so
 * the local passthrough binding actually serves SQL. Caching is disabled
 * for prop parity with the live suites (Hyperdrive's default SELECT cache
 * poisons read-after-write assertions; the local passthrough has no cache).
 */
export const LocalHyperdrive = Effect.gen(function* () {
  const project = yield* Neon.Project("HyperdriveLocalProject");
  return yield* Cloudflare.Hyperdrive.Connection("HyperdriveLocalConnection", {
    origin: project.origin,
    caching: { disabled: true },
    dev: project.origin,
  });
});

/**
 * Effect-native Worker binding the locally-emulated Hyperdrive Connection.
 * `/query` runs a trivial SQL statement through `SQL.Postgres` over the
 * binding's connection string — under `alchemy dev` that string points
 * straight at the `dev` origin (the local runtime's origin passthrough).
 */
export default class HyperdriveLocalWorker extends Cloudflare.Worker<HyperdriveLocalWorker>()(
  "HyperdriveLocalWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const hd = yield* Cloudflare.Hyperdrive.Connect(LocalHyperdrive);
    const sql = yield* SQL.Postgres({ url: hd.connectionString });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/query") {
          const rows = (yield* sql`
            SELECT 1 + 1 AS sum, current_database() AS db
          `) as ReadonlyArray<{ sum: number; db: string }>;
          const host = yield* hd.host;
          return yield* HttpServerResponse.json({ row: rows[0], host });
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

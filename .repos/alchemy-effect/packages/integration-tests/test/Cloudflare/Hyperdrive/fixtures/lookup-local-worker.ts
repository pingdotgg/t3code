import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as SQL from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { lookupConfigName } from "./lookup.ts";

/**
 * An existing Hyperdrive configuration looked up by name, with a `dev`
 * origin (the real Neon Postgres) so `alchemy dev` can emulate the binding —
 * the API never returns a looked-up configuration's origin password.
 */
export const LocalLookupHyperdrive = Effect.gen(function* () {
  const project = yield* Neon.Project("HyperdriveLookupLocalProject");
  return Cloudflare.Hyperdrive.lookup("HyperdriveLookupLocal", {
    name: lookupConfigName("local"),
    dev: project.origin,
  });
});

/**
 * Effect-native Worker binding the looked-up configuration. `/query` runs
 * SQL over the binding's connection string, which under `alchemy dev`
 * points at the `dev` origin.
 */
export default class HyperdriveLookupLocalWorker extends Cloudflare.Worker<HyperdriveLookupLocalWorker>()(
  "HyperdriveLookupLocalWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const hd = yield* Cloudflare.Hyperdrive.Connect(yield* LocalLookupHyperdrive);
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

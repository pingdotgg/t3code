import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as SQL from "@/SQL/Postgres.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * `Alchemy.remote()` opts the Connection OUT of local emulation: even under
 * `alchemy dev` the live provider creates a real Hyperdrive config on
 * Cloudflare. The locally-served Worker's binding still passes through to
 * the config's origin (no `dev` override here), so SQL round-trips against
 * the real Neon database fronted by the real config.
 */
export const RemoteHyperdrive = Effect.gen(function* () {
  const project = yield* Neon.Project("HyperdriveRemoteProject");
  return yield* Cloudflare.Hyperdrive.Connection("HyperdriveRemoteConnection", {
    origin: project.origin,
    caching: { disabled: true },
  }).pipe(Alchemy.remote());
});

/**
 * Effect-native Worker binding the `Alchemy.remote()` Hyperdrive Connection.
 * Same route surface as the local fixture so the test drives both legs the
 * same way.
 */
export default class HyperdriveRemoteWorker extends Cloudflare.Worker<HyperdriveRemoteWorker>()(
  "HyperdriveRemoteWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const hd = yield* Cloudflare.Hyperdrive.Connect(RemoteHyperdrive);
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

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as SQL from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { AccessOriginConnection } from "./access-origin.ts";

/**
 * Effect Worker that binds the Access-protected Hyperdrive through
 * `Cloudflare.Hyperdrive.Connect` and runs a query through it, so a 200
 * proves the whole path: Hyperdrive → Access → Tunnel → Postgres.
 */
export default class HyperdriveAccessEffectWorker extends Cloudflare.Worker<HyperdriveAccessEffectWorker>()(
  "HyperdriveAccessEffectWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const connection = yield* AccessOriginConnection;
    const hd = yield* Cloudflare.Hyperdrive.Connect(connection);
    const sql = yield* SQL.Postgres({ url: hd.connectionString });
    return {
      fetch: sql`select 'through-access' as via`.pipe(
        Effect.flatMap((rows) => HttpServerResponse.json(rows[0])),
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}

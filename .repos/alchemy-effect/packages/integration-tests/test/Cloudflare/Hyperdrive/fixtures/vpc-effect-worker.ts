import * as Cloudflare from "@alchemy.run/cloudflare";
import * as SQL from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { VpcOriginConnection } from "./vpc-origin.ts";

/**
 * Effect Worker that binds the Workers VPC Hyperdrive through
 * `Cloudflare.Hyperdrive.Connect` and runs a query through it, so a 200
 * proves the whole path: Hyperdrive → VPC Service → Tunnel → Postgres.
 */
export default class HyperdriveVpcEffectWorker extends Cloudflare.Worker<HyperdriveVpcEffectWorker>()(
  "HyperdriveVpcEffectWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const connection = yield* VpcOriginConnection;
    const hd = yield* Cloudflare.Hyperdrive.Connect(connection);
    const sql = yield* SQL.Postgres({ url: hd.connectionString });
    return {
      fetch: sql`select 'through-vpc' as via`.pipe(
        Effect.flatMap((rows) => HttpServerResponse.json(rows[0])),
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}

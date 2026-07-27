import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import SqlPostgresWorker from "./postgres-worker.ts";

/**
 * Neon Postgres origin + Hyperdrive + Worker for the `SQL.Postgres` client
 * suite. Kept in its own file so it can also be driven directly, e.g.
 * `alchemy tail --stage test ./test/SQL/fixtures/postgres-stack.ts`.
 */
export default Alchemy.Stack(
  "SqlPostgresStack",
  {
    providers: Layer.merge(Cloudflare.providers(), Neon.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* SqlPostgresWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);

import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Planetscale from "@/Planetscale/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import SqlMySQLWorker from "./mysql-worker.ts";

/**
 * PlanetScale MySQL origin + Hyperdrive + Worker for the `SQL.MySQL` client
 * suite. Kept in its own file so it can also be driven directly, e.g.
 * `alchemy tail --stage test ./test/SQL/fixtures/mysql-stack.ts`.
 */
export default Alchemy.Stack(
  "SqlMySQLStack",
  {
    providers: Layer.merge(Cloudflare.providers(), Planetscale.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* SqlMySQLWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);

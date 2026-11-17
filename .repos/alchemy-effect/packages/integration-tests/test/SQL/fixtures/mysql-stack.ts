import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import SqlMySQLWorker from "./mysql-worker.ts";

/**
 * PlanetScale MySQL origin + Hyperdrive + Worker for the `SQL.MySQL` client
 * suite. Kept in its own file so it can also be driven directly, e.g.
 * `alchemy logs --tail --stage test --config ./test/SQL/fixtures/mysql-stack.ts`.
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

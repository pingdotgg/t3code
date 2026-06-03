import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Planetscale from "alchemy/Planetscale";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import Api from "./src/Api.ts";
import { Hyperdrive, PlanetscaleDb } from "./src/Db.ts";

export default Alchemy.Stack(
  "CloudflarePlanetscalePostgresDrizzleExample",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Drizzle.providers(),
      Planetscale.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { database, branch } = yield* PlanetscaleDb;
    const hd = yield* Hyperdrive;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
      databaseId: database.id,
      branchName: branch.name,
      hyperdriveId: hd.hyperdriveId,
    };
  }),
);

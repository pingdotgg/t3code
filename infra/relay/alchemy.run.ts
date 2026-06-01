// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Planetscale from "alchemy/Planetscale";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { PlanetscaleDatabase, RelayHyperdrive } from "./src/db.ts";
import Api from "./src/worker.ts";

export default Alchemy.Stack(
  "T3CodeRelay",
  {
    providers: Layer.mergeAll(
      Axiom.providers(),
      Cloudflare.providers(),
      Drizzle.providers(),
      Planetscale.providers(),
      FetchHttpClient.layer,
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const db = yield* PlanetscaleDatabase;
    const hyperdrive = yield* RelayHyperdrive;
    const api = yield* Api;

    return {
      databaseName: db.database.name,
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
    };
  }),
);

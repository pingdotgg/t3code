import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import Api from "./src/Api.ts";
import { Hyperdrive, NeonDb } from "./src/Db.ts";

export default Alchemy.Stack(
  "CloudflareNeonPrismaExample",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Prisma.providers(),
      Neon.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { branch } = yield* NeonDb;
    const hd = yield* Hyperdrive;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
      branchId: branch.branchId,
      hyperdriveId: hd.hyperdriveId,
    };
  }),
);

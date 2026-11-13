import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as Prisma from "@alchemy.run/prisma";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Db, Hyperdrive } from "./db.ts";
import PrismaOrmWorker from "./worker.ts";

/**
 * Deploys the Prisma contract + migrations, a Neon project + branch, a
 * Hyperdrive pointed at it, and the {@link PrismaOrmWorker} that runs the
 * Prisma runtime client on workerd. Standalone so it can also be driven
 * by `alchemy deploy`/`alchemy tail` while iterating.
 */
export default Alchemy.Stack(
  "PrismaOrmStack",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers(), Prisma.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* Db;
    yield* Hyperdrive;
    const worker = yield* PrismaOrmWorker;
    return { url: worker.url.as<string>() };
  }),
);

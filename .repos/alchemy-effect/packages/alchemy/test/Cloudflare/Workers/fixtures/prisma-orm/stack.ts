import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as Prisma from "@/Prisma/index.ts";
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
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Neon.providers(),
      Prisma.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* Db;
    yield* Hyperdrive;
    const worker = yield* PrismaOrmWorker;
    return { url: worker.url.as<string>() };
  }),
);

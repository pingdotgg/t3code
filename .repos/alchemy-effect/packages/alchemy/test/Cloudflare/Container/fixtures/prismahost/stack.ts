import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Prisma from "@/Prisma";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import PrismaHostContainerWorker from "./worker.ts";

/**
 * Dev-only stack for the #1334 Prisma-from-container path: a local
 * `@prisma/dev` database handed to an arbitrary image as `DATABASE_URL`.
 */
export default Alchemy.Stack(
  "PrismaHostContainerStack",
  {
    providers: Layer.merge(Cloudflare.providers(), Prisma.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* PrismaHostContainerWorker;
    return { url: worker.url.as<string>() };
  }),
);

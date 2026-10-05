import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "PrismaWebsiteTanStackStartExample",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Prisma.Website.TanStackStart("TanStackStart", {
      env: { GREETING: "Hello from TanStack Start on Prisma!" },
    });

    return { url: site.url };
  }),
);

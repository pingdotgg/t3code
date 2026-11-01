import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "PrismaWebsiteOctaneExample",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Prisma.Website.Octane("Octane", {
      env: { GREETING: "Hello from Octane on Prisma!" },
    });

    return { url: site.url };
  }),
);

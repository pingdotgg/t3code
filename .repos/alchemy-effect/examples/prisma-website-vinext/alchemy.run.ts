import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "PrismaWebsiteVinextExample",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Prisma.Website.Vinext("Web", {
      env: { GREETING: "Hello from vinext on Prisma!" },
    });
    return { url: site.url };
  }),
);

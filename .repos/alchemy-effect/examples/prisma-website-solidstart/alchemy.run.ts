import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "PrismaWebsiteSolidStartExample",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Prisma.Website.SolidStart("SolidStart", {
      env: { GREETING: "Hello from SolidStart on Prisma!" },
    });

    return { url: site.url };
  }),
);

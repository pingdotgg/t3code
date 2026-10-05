import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "PrismaWebsiteWakuExample",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Prisma.Website.Waku("Waku", {
      env: { GREETING: "Hello from Waku on Prisma!" },
    });

    return { url: site.url };
  }),
);

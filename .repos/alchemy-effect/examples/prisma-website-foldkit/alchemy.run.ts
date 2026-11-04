import * as Prisma from "@alchemy.run/prisma";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "PrismaWebsiteFoldkitExample",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Prisma.Website.Foldkit("Foldkit", {});

    return { url: site.url };
  }),
);

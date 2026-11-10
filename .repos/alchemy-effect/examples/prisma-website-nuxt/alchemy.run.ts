import * as Prisma from "@alchemy.run/prisma";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "PrismaWebsiteNuxtExample",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Prisma.Website.Nuxt("Nuxt", {
      env: { GREETING: "Hello from Nuxt on Prisma!" },
    });

    return { url: site.url };
  }),
);

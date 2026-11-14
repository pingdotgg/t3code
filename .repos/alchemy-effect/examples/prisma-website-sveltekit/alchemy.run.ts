import * as Prisma from "@alchemy.run/prisma";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "PrismaWebsiteSvelteKitExample",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Prisma.Website.SvelteKit("SvelteKit", {
      env: { GREETING: "Hello from SvelteKit on Prisma!" },
    });

    return { url: site.url };
  }),
);

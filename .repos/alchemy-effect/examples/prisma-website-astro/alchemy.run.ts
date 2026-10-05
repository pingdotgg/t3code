import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "PrismaWebsiteAstroExample",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Prisma.Website.Astro("Astro", {
      env: { GREETING: "Hello from Astro on Prisma!" },
    });

    const staticSite = yield* Prisma.Website.Astro("AstroStatic", {
      astro: {
        output: "static",
        srcDir: "./static-src",
        outDir: "./dist-static",
      },
    });

    return { url: site.url, staticUrl: staticSite.url };
  }),
);

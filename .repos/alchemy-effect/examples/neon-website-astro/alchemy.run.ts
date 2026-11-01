import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "NeonWebsiteAstroExample",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Neon.Website.Astro("Astro", {
      env: { GREETING: "Hello from Astro on Neon!" },
    });

    const staticSite = yield* Neon.Website.Astro("AstroStatic", {
      astro: {
        output: "static",
        srcDir: "./static-src",
        outDir: "./dist-static",
      },
    });

    return { url: site.url, staticUrl: staticSite.url };
  }),
);

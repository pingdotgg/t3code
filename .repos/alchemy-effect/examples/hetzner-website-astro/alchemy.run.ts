import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "HetznerWebsiteAstroExample",
  {
    providers: Hetzner.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Hetzner.Website.Astro("Astro", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Astro build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "astro.config.ts"],
      },
      env: {
        GREETING: "Hello from Astro on Hetzner!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

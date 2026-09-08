import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "RailwayWebsiteAstroExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Railway.Website.Astro("Astro", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Astro build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "astro.config.ts"],
      },
      env: {
        GREETING: "Hello from Astro on Railway!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

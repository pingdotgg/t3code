import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "FlyWebsiteAstroExample",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Fly.Website.Astro("Astro", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Astro build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "astro.config.ts"],
      },
      env: {
        GREETING: "Hello from Astro on Fly!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

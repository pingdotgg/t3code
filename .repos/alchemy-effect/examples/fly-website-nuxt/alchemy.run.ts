import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "FlyWebsiteNuxtExample",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Fly.Website.Nuxt("NuxtSite", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Nuxt build (and the deploy) entirely.
      memo: {
        include: [
          "app/**",
          "server/**",
          "public/**",
          "package.json",
          "nuxt.config.ts",
          "tsconfig.json",
        ],
      },
      env: {
        GREETING: "Hello from Nuxt on Fly!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

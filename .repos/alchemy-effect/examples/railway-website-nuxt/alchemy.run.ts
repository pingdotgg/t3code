import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "RailwayWebsiteNuxtExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Railway.Website.Nuxt("NuxtSite", {
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
        GREETING: "Hello from Nuxt on Railway!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

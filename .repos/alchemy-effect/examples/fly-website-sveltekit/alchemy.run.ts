import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "FlyWebsiteSvelteKitExample",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Fly.Website.SvelteKit("SvelteKitSite", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the SvelteKit build (and the deploy) entirely.
      memo: {
        include: [
          "src/**",
          "static/**",
          "package.json",
          "vite.config.ts",
          "tsconfig.json",
        ],
      },
      env: {
        GREETING: "Hello from SvelteKit on Fly!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

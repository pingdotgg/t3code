import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "HetznerWebsiteSvelteKitExample",
  {
    providers: Hetzner.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Hetzner.Website.SvelteKit("SvelteKitSite", {
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
        GREETING: "Hello from SvelteKit on Hetzner!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

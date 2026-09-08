import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareWebsiteSvelteKitExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Website.SvelteKit("SvelteKitSite", {
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
        GREETING: "Hello from SvelteKit on Cloudflare!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

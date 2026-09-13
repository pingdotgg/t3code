import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareWebsiteNuxtExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Website.Nuxt("NuxtSite", {
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
        GREETING: "Hello from Nuxt on Cloudflare!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

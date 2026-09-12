import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareWebsiteNextjsExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Website.Nextjs("Nextjs", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the OpenNext build (and the deploy) entirely.
      memo: {
        include: [
          "app/**",
          "public/**",
          "package.json",
          "next.config.mjs",
          "postcss.config.mjs",
          "open-next.config.ts",
          "tsconfig.json",
        ],
      },
      env: {
        GREETING: "Hello from Next.js on Cloudflare!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

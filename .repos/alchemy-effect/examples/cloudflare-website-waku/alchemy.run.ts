import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareWebsiteWakuExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Website.Waku("WakuSite", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Waku build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "waku.config.ts"],
      },
      // Waku's server runtime needs AsyncLocalStorage.
      compatibility: {
        flags: ["nodejs_als"],
      },
      env: {
        GREETING: "Hello from Waku on Cloudflare!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

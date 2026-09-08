import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareWebsiteViteExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // A plain Vite SPA: no `main` entry needed — Alchemy runs Vite with
    // this project's own vite.config.ts, merging its Cloudflare
    // integration on top, and deploys the client assets on a Worker.
    const site = yield* Cloudflare.Website.Vite("Website", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Vite build (and the deploy) entirely.
      memo: {
        include: ["src/**", "index.html", "package.json", "vite.config.ts"],
      },
    });

    return {
      url: site.url,
    };
  }),
);

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareWebsiteReactRouterExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // React Router's RSC build emits multiple server environments (`rsc`
    // and `ssr`); `viteEnvironments` tells Alchemy how they assemble into
    // one Worker: the `rsc` environment is the Worker entry, and the `ssr`
    // environment's chunks are bundled alongside so cross-environment
    // `loadModule` calls resolve in the deployed Worker.
    const site = yield* Cloudflare.Website.Vite("Website", {
      compatibility: {
        date: "2026-03-10",
        flags: ["nodejs_compat"],
      },
      // Only hash the files that affect the build, so unchanged sources
      // skip the Vite build (and the deploy) entirely.
      memo: {
        include: [
          "app/**",
          "react-router-vite/**",
          "public/**",
          "package.json",
          "vite.config.ts",
        ],
      },
      env: {
        GREETING: "Hello from React Router on Cloudflare!",
      },
      viteEnvironments: {
        entry: "rsc",
        children: ["ssr"],
      },
    });

    return {
      url: site.url,
    };
  }),
);

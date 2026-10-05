import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "NeonWebsiteStaticSiteExample",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Neon.Website.StaticSite("StaticSite", {
      command: "bun run build",
      outdir: "dist",
      dev: { command: "bun run dev:site" },
    });

    return { url: site.url };
  }),
);

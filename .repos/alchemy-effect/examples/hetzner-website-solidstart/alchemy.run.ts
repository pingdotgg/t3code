import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "HetznerWebsiteSolidStartExample",
  {
    providers: Hetzner.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Hetzner.Website.SolidStart("Website", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the SolidStart build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "vite.config.ts"],
      },
      env: {
        GREETING: "Hello from SolidStart on Hetzner!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

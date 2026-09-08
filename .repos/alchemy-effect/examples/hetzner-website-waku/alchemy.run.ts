import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "HetznerWebsiteWakuExample",
  {
    providers: Hetzner.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Hetzner.Website.Waku("WakuSite", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Waku build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "waku.config.ts"],
      },
      env: {
        GREETING: "Hello from Waku on Hetzner!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

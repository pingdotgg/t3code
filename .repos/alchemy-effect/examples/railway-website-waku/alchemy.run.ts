import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "RailwayWebsiteWakuExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Railway.Website.Waku("WakuSite", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Waku build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "waku.config.ts"],
      },
      env: {
        GREETING: "Hello from Waku on Railway!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

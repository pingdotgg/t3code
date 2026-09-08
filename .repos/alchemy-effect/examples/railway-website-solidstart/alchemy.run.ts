import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "RailwayWebsiteSolidStartExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Railway.Website.SolidStart("Website", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the SolidStart build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "vite.config.ts"],
      },
      env: {
        GREETING: "Hello from SolidStart on Railway!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

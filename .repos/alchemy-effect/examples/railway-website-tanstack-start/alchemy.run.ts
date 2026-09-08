import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "RailwayWebsiteTanStackStartExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Railway.Website.TanStackStart("Website", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Vite build (and the deploy) entirely.
      memo: {
        include: ["src/**", "package.json", "vite.config.ts"],
      },
      env: {
        GREETING: "Hello from TanStack Start on Railway!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

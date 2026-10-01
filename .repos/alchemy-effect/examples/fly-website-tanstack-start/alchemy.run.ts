import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "FlyWebsiteTanStackStartExample",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Fly.Website.TanStackStart("Website", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Vite build (and the deploy) entirely.
      memo: {
        include: ["src/**", "package.json", "vite.config.ts"],
      },
      env: {
        GREETING: "Hello from TanStack Start on Fly!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

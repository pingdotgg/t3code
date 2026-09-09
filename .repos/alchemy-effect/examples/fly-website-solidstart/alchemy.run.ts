import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "FlyWebsiteSolidStartExample",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Fly.Website.SolidStart("Website", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the SolidStart build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "vite.config.ts"],
      },
      env: {
        GREETING: "Hello from SolidStart on Fly!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

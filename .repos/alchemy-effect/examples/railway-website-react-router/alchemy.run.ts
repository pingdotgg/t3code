import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "RailwayWebsiteReactRouterExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Railway.Website.ReactRouter("Website", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the React Router build (and the deploy) entirely.
      memo: {
        include: [
          "app/**",
          "public/**",
          "package.json",
          "react-router.config.ts",
          "vite.config.ts",
        ],
      },
      env: {
        GREETING: "Hello from React Router on Railway!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "RailwayWebsiteVinextExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Railway.Website.Vinext("Vinext", {
      memo: {
        lockfile: true,
        include: [
          "app/**",
          "public/**",
          "package.json",
          "vite.config.ts",
          "tsconfig.json",
        ],
      },
      env: {
        GREETING: "Hello from vinext on Railway!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

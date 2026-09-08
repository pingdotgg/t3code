import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "RailwayWebsiteNextjsExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Railway.Website.Nextjs("Nextjs", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Node build (and the deploy) entirely.
      memo: {
        include: [
          "app/**",
          "public/**",
          "package.json",
          "next.config.mjs",
          "postcss.config.mjs",
          "tsconfig.json",
        ],
      },
      env: {
        GREETING: "Hello from Next.js on Railway!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

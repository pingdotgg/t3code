import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "FlyWebsiteNextjsExample",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Fly.Website.Nextjs("Nextjs", {
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
        GREETING: "Hello from Next.js on Fly!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

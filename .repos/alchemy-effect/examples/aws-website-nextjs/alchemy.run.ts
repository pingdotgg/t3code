import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsWebsiteNextjsExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.Nextjs("Nextjs", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the OpenNext build (and the deploy) entirely.
      memo: {
        include: [
          "app/**",
          "public/**",
          "package.json",
          "next.config.mjs",
          "postcss.config.mjs",
          "open-next.config.ts",
          "tsconfig.json",
        ],
      },
      forceDestroy: true,
      env: {
        GREETING: "Hello from Next.js on AWS!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

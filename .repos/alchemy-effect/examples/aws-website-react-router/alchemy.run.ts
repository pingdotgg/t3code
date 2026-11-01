import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsWebsiteReactRouterExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.ReactRouter("Website", {
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
      forceDestroy: true,
      env: {
        GREETING: "Hello from React Router on AWS!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

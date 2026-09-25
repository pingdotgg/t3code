import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsWebsiteNuxtExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.Nuxt("NuxtSite", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Nuxt build (and the deploy) entirely.
      memo: {
        include: [
          "app/**",
          "server/**",
          "public/**",
          "package.json",
          "nuxt.config.ts",
          "tsconfig.json",
        ],
      },
      forceDestroy: true,
      env: {
        GREETING: "Hello from Nuxt on AWS!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

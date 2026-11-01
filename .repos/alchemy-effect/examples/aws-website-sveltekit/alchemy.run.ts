import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsWebsiteSvelteKitExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.SvelteKit("SvelteKitSite", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the SvelteKit build (and the deploy) entirely.
      memo: {
        include: [
          "src/**",
          "static/**",
          "package.json",
          "vite.config.ts",
          "tsconfig.json",
        ],
      },
      forceDestroy: true,
      env: {
        GREETING: "Hello from SvelteKit on AWS!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsWebsiteTanStackStartExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.TanStackStart("Website", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Vite build (and the deploy) entirely.
      memo: {
        include: ["src/**", "package.json", "vite.config.ts"],
      },
      forceDestroy: true,
      env: {
        GREETING: "Hello from TanStack Start on AWS!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

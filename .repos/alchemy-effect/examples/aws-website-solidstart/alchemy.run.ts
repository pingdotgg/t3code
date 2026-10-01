import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsWebsiteSolidStartExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.SolidStart("Website", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the SolidStart build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "vite.config.ts"],
      },
      forceDestroy: true,
      env: {
        GREETING: "Hello from SolidStart on AWS!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

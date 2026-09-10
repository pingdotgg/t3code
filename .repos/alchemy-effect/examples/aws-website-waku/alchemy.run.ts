import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsWebsiteWakuExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.Waku("WakuSite", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Waku build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "waku.config.ts"],
      },
      forceDestroy: true,
      env: {
        GREETING: "Hello from Waku on AWS!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

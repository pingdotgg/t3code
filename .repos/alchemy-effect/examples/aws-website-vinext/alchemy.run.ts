import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsWebsiteVinextExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.Vinext("Vinext", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the vinext build (and the deploy) entirely.
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
      forceDestroy: true,
      env: {
        GREETING: "Hello from vinext on AWS!",
      },
    });

    return {
      url: site.url,
      cacheBucketName: site.cacheBucket?.bucketName,
    };
  }),
);

import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsWebsiteViteExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    // A plain Vite SPA: static assets in S3 behind CloudFront. `spa`
    // defaults on, so unmatched paths answer with the index page (200).
    const site = yield* AWS.Website.Vite("Website", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Vite build (and the deploy) entirely.
      memo: {
        include: ["src/**", "index.html", "package.json", "vite.config.ts"],
      },
      forceDestroy: true,
    });

    return {
      url: site.url,
    };
  }),
);

import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsWebsiteFoldkitExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.Foldkit("Foldkit", {
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

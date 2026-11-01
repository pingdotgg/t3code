import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "GcpWebsiteNextjsExample",
  {
    providers: GCP.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* GCP.Website.Nextjs("Nextjs", {
      // Only hash the files that affect the build, so unchanged sources
      // skip `next build` (and the image rebuild) entirely.
      memo: {
        include: [
          "app/**",
          "public/**",
          "package.json",
          "next.config.mjs",
          "postcss.config.mjs",
          "tsconfig.json",
        ],
      },
      env: {
        GREETING: "Hello from Next.js on Cloud Run!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

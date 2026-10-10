import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "GcpWebsiteAstroExample",
  {
    providers: GCP.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* GCP.Website.Astro("Astro", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Astro build (and the image rebuild) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "astro.config.ts"],
      },
      env: {
        GREETING: "Hello from Astro on Cloud Run!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "HetznerWebsiteVinextExample",
  {
    providers: Hetzner.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Hetzner.Website.Vinext("Vinext", {
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
      env: {
        GREETING: "Hello from vinext on Hetzner!",
      },
    });

    return {
      url: site.url,
    };
  }),
);

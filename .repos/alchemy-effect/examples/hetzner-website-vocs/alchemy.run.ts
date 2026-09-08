import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "HetznerWebsiteVocsExample",
  {
    providers: Hetzner.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Hetzner.Website.Vocs("VocsDocs", {
      memo: {
        include: ["src/**", "public/**", "package.json", "vocs.config.ts"],
      },
    });

    return {
      url: site.url,
    };
  }),
);

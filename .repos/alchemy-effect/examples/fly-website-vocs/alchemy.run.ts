import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "FlyWebsiteVocsExample",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Fly.Website.Vocs("VocsDocs", {
      memo: {
        include: ["src/**", "public/**", "package.json", "vocs.config.ts"],
      },
    });

    return {
      url: site.url,
    };
  }),
);

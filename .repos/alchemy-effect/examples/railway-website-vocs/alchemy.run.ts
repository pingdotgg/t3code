import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "RailwayWebsiteVocsExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Railway.Website.Vocs("VocsDocs", {
      memo: {
        include: ["src/**", "public/**", "package.json", "vocs.config.ts"],
      },
    });

    return {
      url: site.url,
    };
  }),
);

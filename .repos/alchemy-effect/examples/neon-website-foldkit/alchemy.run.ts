import * as Neon from "@alchemy.run/neon";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "NeonWebsiteFoldkitExample",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Neon.Website.Foldkit("Foldkit", {});

    return { url: site.url };
  }),
);

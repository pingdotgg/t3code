import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "NeonWebsiteSolidStartExample",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Neon.Website.SolidStart("SolidStart", {
      env: { GREETING: "Hello from SolidStart on Neon!" },
    });

    return { url: site.url };
  }),
);

import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "NeonWebsiteWakuExample",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Neon.Website.Waku("Waku", {
      env: { GREETING: "Hello from Waku on Neon!" },
    });

    return { url: site.url };
  }),
);

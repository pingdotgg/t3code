import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "NeonWebsiteTanStackStartExample",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Neon.Website.TanStackStart("TanStackStart", {
      env: { GREETING: "Hello from TanStack Start on Neon!" },
    });

    return { url: site.url };
  }),
);

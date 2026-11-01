import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "NeonWebsiteOctaneExample",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Neon.Website.Octane("Octane", {
      env: { GREETING: "Hello from Octane on Neon!" },
    });

    return { url: site.url };
  }),
);

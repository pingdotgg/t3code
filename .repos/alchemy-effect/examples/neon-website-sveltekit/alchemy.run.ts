import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "NeonWebsiteSvelteKitExample",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Neon.Website.SvelteKit("SvelteKit", {
      env: { GREETING: "Hello from SvelteKit on Neon!" },
    });

    return { url: site.url };
  }),
);

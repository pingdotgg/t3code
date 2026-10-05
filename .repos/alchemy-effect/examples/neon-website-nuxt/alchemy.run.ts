import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "NeonWebsiteNuxtExample",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Neon.Website.Nuxt("Nuxt", {
      env: { GREETING: "Hello from Nuxt on Neon!" },
    });

    return { url: site.url };
  }),
);

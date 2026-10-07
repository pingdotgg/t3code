import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "NeonWebsiteReactRouterExample",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Neon.Website.ReactRouter("ReactRouter", {
      env: { GREETING: "Hello from React Router on Neon!" },
    });

    return { url: site.url };
  }),
);

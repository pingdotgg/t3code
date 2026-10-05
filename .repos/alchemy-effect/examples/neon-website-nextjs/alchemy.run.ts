import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "NeonWebsiteNextjsExample",
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Neon.Website.Nextjs("Nextjs", {
      env: { GREETING: "Hello from Next.js on Neon!" },
    });

    return { url: site.url };
  }),
);

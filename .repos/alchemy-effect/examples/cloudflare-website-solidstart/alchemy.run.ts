import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareSolidStartExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Website.Vite("CloudflareSolidStart", {
      compatibility: {
        flags: ["nodejs_compat"],
      },
      env: {
        GREETING: "Hello from SolidStart on Cloudflare!",
      },
    });

    return {
      url: worker.url,
    };
  }),
);

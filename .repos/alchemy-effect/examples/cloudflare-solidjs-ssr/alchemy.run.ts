import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareSolidJSSSRExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Website.Vite("SolidJSSrr", {
      assets: {
        runWorkerFirst: true,
      },
    });

    return {
      url: worker.url,
    };
  }),
);

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Shorty",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const web = yield* Cloudflare.Website.Vite("Web", {
      dev: { port: 5173 },
    });

    return { web: web.url };
  }),
);

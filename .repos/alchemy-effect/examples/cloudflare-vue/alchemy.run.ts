import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareVueExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Website.Vite("Vue", {
      compatibility: {
        flags: ["nodejs_compat"],
      },
      memo: {},
    });

    return {
      url: worker.url,
    };
  }),
);

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
      // vue-router runs in history mode, so deep links like /about must
      // fall back to index.html for the client router to resolve them.
      assets: {
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "single-page-application",
      },
    });

    return {
      url: worker.url,
    };
  }),
);

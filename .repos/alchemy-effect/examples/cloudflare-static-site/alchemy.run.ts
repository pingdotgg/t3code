import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareStatic",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    //fix url when no dev command present
    const worker = yield* Cloudflare.Website.StaticSite("Website", {
      command: "zola build",
      dev: {
        command: "zola serve",
        //   url: "http://localhost:1111",
      },
      outdir: "public",
      assets: {
        notFoundHandling: "404-page",
      },
    });

    return {
      url: worker.url,
    };
  }),
);

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareFoldkitSsrExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Website.Foldkit("FoldkitSsr", {
      // Rendering happens at the edge, so the deployment needs a Worker.
      main: "src/worker.ts",
      // Both settings are load-bearing, and getting either wrong fails
      // quietly — the site serves 200s that carry an empty document.
      //
      // `notFoundHandling: "none"` lets a request that matches no file reach
      // the Worker instead of being answered with the template.
      // `htmlHandling: "none"` stops the asset layer resolving `/` to
      // `/index.html` on its own, which would serve the unrendered template
      // for the front page alone.
      //
      // Files still come straight from the asset layer; only page requests
      // reach the Worker. `/index.html` keeps matching literally, which is
      // where the Worker reads its shell from.
      assets: {
        htmlHandling: "none",
        notFoundHandling: "none",
      },
    });

    return {
      url: worker.url,
    };
  }),
);

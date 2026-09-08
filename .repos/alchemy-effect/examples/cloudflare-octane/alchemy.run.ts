import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareOctaneExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // Server routes read the namespace at request time via
    // `context.platform.env.CACHE` (see octane.config.ts).
    const cache = yield* Cloudflare.KV.Namespace("Cache");

    const site = yield* Cloudflare.Website.Octane("CloudflareOctane", {
      env: {
        CACHE: cache,
      },
    });

    return {
      url: site.url,
    };
  }),
);

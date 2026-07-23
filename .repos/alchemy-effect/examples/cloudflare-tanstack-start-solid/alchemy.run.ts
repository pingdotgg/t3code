import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export const Website = Cloudflare.Vite("Website", {
  compatibility: {
    flags: ["nodejs_compat"],
  },
});

export default Alchemy.Stack(
  "CloudflareTanstackStartSolidExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const website = yield* Website;
    return {
      websiteUrl: website.url.as<string>(),
    };
  }),
);

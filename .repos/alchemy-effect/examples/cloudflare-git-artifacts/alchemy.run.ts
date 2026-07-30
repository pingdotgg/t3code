import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Worker.ts";

export default Alchemy.Stack(
  "CloudflareGitArtifacts",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
    };
  }),
);

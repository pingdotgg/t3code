import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as Planetscale from "alchemy/Planetscale";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "Nuke",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      AWS.providers(),
      Neon.providers(),
      Planetscale.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {}),
);

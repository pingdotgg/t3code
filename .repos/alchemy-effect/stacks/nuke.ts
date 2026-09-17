import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Fly from "alchemy/Fly";
import * as Hetzner from "alchemy/Hetzner";
import * as Railway from "alchemy/Railway";
import * as Neon from "alchemy/Neon";
import * as Planetscale from "alchemy/Planetscale";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "Nuke",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      AWS.providers(),
      Hetzner.providers(),
      Fly.providers(),
      Railway.providers(),
      Neon.providers(),
      Planetscale.providers(),
      // Prisma credentials resolve at layer build like Neon/Planetscale:
      // set PRISMA_SERVICE_TOKEN (with CI=1) or configure the profile.
      Prisma.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {}),
);

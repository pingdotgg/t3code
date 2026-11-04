import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Fly from "@alchemy.run/fly";
import * as GCP from "@alchemy.run/gcp";
import * as Hetzner from "@alchemy.run/hetzner";
import * as Neon from "@alchemy.run/neon";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Prisma from "@alchemy.run/prisma";
import * as Railway from "@alchemy.run/railway";
import * as Stripe from "@alchemy.run/stripe";
import * as Turso from "@alchemy.run/turso";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "Nuke",
  {
    providers: Layer.mergeAll(
      AWS.providers(),
      Cloudflare.providers(),
      Fly.providers(),
      GCP.providers(),
      Hetzner.providers(),
      Neon.providers(),
      Planetscale.providers(),
      Prisma.providers(),
      Railway.providers(),
      Stripe.providers(),
      Turso.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.void,
);

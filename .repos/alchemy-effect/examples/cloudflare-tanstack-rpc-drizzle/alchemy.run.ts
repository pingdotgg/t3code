import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Backend from "./src/backend/api.ts";
import { Hyperdrive, NeonDatabase } from "./src/backend/database.ts";

/**
 * The TanStack Start frontend. Deployed as a Cloudflare Worker + static assets
 * by `Cloudflare.Website.Vite`. The `Backend` RPC worker is injected as a private
 * `BACKEND` service binding; the `/rpc` server route proxies the browser's
 * `AtomRpc` traffic to it.
 */
export class Website extends Cloudflare.Website.Vite<Website>()("Website", {
  compatibility: {
    flags: ["nodejs_compat", "enable_request_signal"],
  },
  env: {
    BACKEND: Backend,
  },
  assets: {
    runWorkerFirst: true,
  },
}) {}

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;

export default Alchemy.Stack(
  "CloudflareTanstackRpcDrizzleExample",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Drizzle.providers(),
      Neon.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { branch } = yield* NeonDatabase;
    const hd = yield* Hyperdrive;
    const website = yield* Website;

    // Backend does not need to be yielded here.
    // The service binding adds it to the resource graph automatically, and there's no direct URL.

    return {
      websiteUrl: website.url.as<string>(),
      branchId: branch.branchId,
      hyperdriveId: hd.hyperdriveId,
    };
  }),
);

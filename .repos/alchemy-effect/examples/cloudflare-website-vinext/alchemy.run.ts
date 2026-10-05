import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Backend from "./src/Backend.ts";
import { KV, DB } from "./src/Bindings";

/** Do not bind `VINEXT_KV_CACHE` — Website.Vinext provisions it. */
export class Vinext extends Cloudflare.Website.Vinext<Vinext>()("Vinext", {
  memo: {
    lockfile: true,
    include: [
      "app/**",
      "public/**",
      "worker/**",
      "src/**",
      "migrations/**",
      "proxy.ts",
      "package.json",
      "vite.config.ts",
      "tsconfig.json",
    ],
  },
  env: {
    GREETING: "Hello from vinext on Cloudflare!",
    BACKEND: Backend,
    KV,
    DB,
  },
}) {}

export type VinextEnv = Cloudflare.InferEnv<typeof Vinext>;

export default Alchemy.Stack(
  "CloudflareWebsiteVinextExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const backend = yield* Backend;
    const site = yield* Vinext;

    return {
      url: site.url,
      apiUrl: backend.url,
    };
  }),
);

# Cloudflare Website: Waku

Deploys a [Waku](https://waku.gg) app to Cloudflare Workers with `Cloudflare.Website.Waku` — no `waku.config.ts`, no Wrangler.

The resource builds the app with waku's own Vite pipeline and a wrangler-free in-memory Cloudflare adapter: the RSC server bundle deploys as the Worker script, and the client output (including SSG-prerendered pages and the RSC payloads) deploys as Worker static assets. Values passed via `env` are readable in server components through waku's `getEnv`.

```ts
const site = yield* Cloudflare.Website.Waku("WakuSite", {
  compatibility: {
    flags: ["nodejs_als"], // waku's server runtime needs AsyncLocalStorage
  },
  env: {
    GREETING: "Hello from Waku on Cloudflare!",
  },
});
```

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # waku's Vite dev server (rsc environment runs in workerd, HMR)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the Worker's source provider is loaded from its `/waku` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- Waku's SSG step renders static pages in **Node** (upstream parity), so a top-level `import { env } from "cloudflare:workers"` in a page module breaks the build — read env via `getEnv` from `waku` (as in `src/pages/index.tsx`) or a guarded dynamic import.

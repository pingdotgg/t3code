# Cloudflare Website: SvelteKit

Deploys a SvelteKit app to Cloudflare Workers with `Cloudflare.Website.SvelteKit` — no `svelte.config.js`, no `@sveltejs/adapter-cloudflare`, no Wrangler.

The resource builds the app with SvelteKit's own Vite pipeline and a wrangler-free in-memory Cloudflare adapter, re-bundles the server output for workerd, and deploys client assets + prerendered pages as Worker static assets. Values passed via `env` are exposed to server routes through `platform.env`.

```ts
const site = yield* Cloudflare.Website.SvelteKit("SvelteKitSite", {
  env: {
    GREETING: "Hello from SvelteKit on Cloudflare!",
  },
});
```

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # SvelteKit's Vite dev server (Node SSR, HMR)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the Worker's source provider is loaded from its `/sveltekit` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, `platform.env` carries the Worker's real Cloudflare bindings (KV, R2, D1, ...) served by the cloudflare-runtime platform proxy, with literal `env` values (strings and secrets) overlaid.

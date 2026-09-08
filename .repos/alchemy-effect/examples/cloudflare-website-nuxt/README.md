# Cloudflare Website: Nuxt

Deploys a Nuxt app to Cloudflare Workers with `Cloudflare.Website.Nuxt` — no `nitro.preset` edits, no Wrangler.

The resource builds the app through the project's own `@nuxt/kit` with nitro's `cloudflare_module` preset (your `nuxt.config.ts` loads natively), deploys the nitro server bundle as the Worker, and serves client assets + prerendered pages as Worker static assets. Values passed via `env` are exposed to server routes and SSR through `event.context.cloudflare.env`.

```ts
const site = yield* Cloudflare.Website.Nuxt("NuxtSite", {
  env: {
    GREETING: "Hello from Nuxt on Cloudflare!",
  },
});
```

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # Nuxt's own dev server (nitro dev, HMR, bindings via platform proxy)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the Worker's source provider is loaded from its `/nuxt` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, `event.context.cloudflare` is served wrangler-free through cloudflare-runtime's platform proxy: resource bindings (KV, R2, D1, ...) resolve against a local workerd instance, and literal `env` values overlay them.
- Nitro's `isr` route rule is Vercel/Netlify-only and silently ignored on Cloudflare — use `prerender` (as `/about` does here) or `cache` route rules instead.
- `test/integ.test.ts` deploys the stack and asserts SSR, the API route, the prerendered page, and static assets over HTTP. It is written but not yet exercised in CI — a live run against the testing account is deferred (test-account embargo at the time this example landed).

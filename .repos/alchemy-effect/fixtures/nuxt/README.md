# fixtures/nuxt

E2E fixture for `@alchemy.run/frontend-frameworks/nuxt`: a Nuxt 4 app built programmatically
through the project's `@nuxt/kit` with nitro's `cloudflare_module` preset —
wrangler-free (no `wrangler.json` is read or written).

What it exercises:

- **Native `nuxt.config.ts` loading** — `runtimeConfig.public.fixtureMarker`
  and the `routeRules["/prerendered"].prerender` rule are user settings the
  suite observes.
- **SSR + runtime contract** — the home page reads
  `event.context.cloudflare.env.FIXTURE_SECRET` during SSR; `/api/hello`
  checks `context.waitUntil`.
- **Prerendering** — `/prerendered` is written into `.output/public` at build
  time and served by the assets layer.
- **Client hydration** — `/counter` flips a `data-hydrated` marker from
  `onMounted` before interaction.
- **The nitro entry/exports seam** — `worker-entry.ts` is the configured
  `main`: nitro bundles it as the worker entry, so its exports (nitro's
  wrapped handler + the `Counter` SQLite Durable Object) are the worker's
  exports; `/api/counter` drives the DO through the `COUNTER` namespace
  binding.

- **KV round-trip** — `/api/kv` puts/gets through
  `event.context.cloudflare.env.FIXTURE_KV` (live: miniflare KV; dev: the
  platform-proxy bridge).

Modes: both the **live** suite (miniflare over `dist/build.json`) and the
**dev** suite run. Dev drives Nuxt's own dev server programmatically
(`loadNuxt({ dev: true })`); SSR runs in nitro's Node worker THREAD, where
the injected nitro plugin serves `event.context.cf` /
`event.context.waitUntil` / `event.context.cloudflare = { request, env,
context }` from cloudflare-runtime's platform proxy over HTTP (`{ url,
token }` via `runtimeConfig`) — wrangler-free, binding state shared with the
host workerd instance and preserved across dev rebuilds. The dev suite also
edits `server/api/hmr.ts` in place (restored in a `finally`) to prove a
rebuild + bridge reconnect.

Dev-mode limitation: the Counter DO spec is live-only — the dev platform
proxy cannot host classes from the worker entry (the entry/exports seam only
exists in the production build), so dev serves Text + KV bindings.

Dev port: 3111.

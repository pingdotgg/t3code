# Cloudflare Website: vinext

Deploys a [vinext](https://vinext.dev) App Router app to Cloudflare
Workers with `Cloudflare.Website.Vinext` — Vite plus the Next.js API,
KV-backed ISR, no `wrangler.jsonc`. This is not the OpenNext path used
by `Cloudflare.Website.Nextjs`.

Alchemy loads the project's `vite.config.ts`, injects the Cloudflare
Vite plugin, deploys the RSC Worker plus client assets, prerenders
routes, and seeds `VINEXT_KV_CACHE`. Values passed via `env` are
available in server components and route handlers as
`import { env } from "cloudflare:workers"`.

- Home is SSR and reads `GREETING`. `/static` is prerendered. `/isr`
  is ISR. `/use-cache` is a dynamic page plus `"use cache"`.
- `/api/*` is an App Router catch-all. Notes go to a sibling Worker
  over the `BACKEND` service binding; `/api/kv` uses the site `KV`.
- `proxy.ts` returns 403 for `/admin`.
- Everything under `public/` deploys as static assets.

```ts
export class Vinext extends Cloudflare.Website.Vinext<Vinext>()("Vinext", {
  env: {
    GREETING: "Hello from vinext on Cloudflare!",
    BACKEND: Backend,
    KV,
  },
});
```

## Run locally

```sh
bun alchemy dev
```

Alchemy starts Vite with hot module replacement and local Worker bindings.
The example includes a counter, cache-refresh server actions, and Notes CRUD.

## Deploy

```sh
bun alchemy deploy --profile testing
```

## Cache and bindings

- Install `vinext`, `@vitejs/plugin-rsc`, and `react-server-dom-webpack`
  in the app. `react-server-dom-webpack` is vinext's RSC flight runtime
  (same package Next uses); the name is historical — this app does not
  use webpack.
- Do not bind `VINEXT_KV_CACHE` or `CF_VERSION_METADATA`. `Website.Vinext`
  provisions the KV namespace, enables Workers Cache, and binds version
  metadata. The resource injects the KV data-cache adapter automatically;
  no Alchemy plugin is needed in `vite.config.ts`. Deploy seeds prerender
  pairs into KV.
- Do not register `@cloudflare/vite-plugin`. Alchemy injects
  `vite-plugin-cloudflare:alchemy` (vinext matches the prefix) and
  no-ops the official plugin if it is still present.
- Unchanged sources skip the Vite build on subsequent deploys (the
  project tree is content-hashed, scoped by `memo.include`).

## Test

```sh
ALCHEMY_PROFILE=testing bun test test/dev.test.ts
ALCHEMY_PROFILE=testing bun test test/integ.test.ts
```

The development suite verifies local routes, bindings, and hot module replacement.
The live suite verifies rendered routes, caching, static assets, the proxy,
D1 writes, and KV round trips. It destroys its deployment after the tests.

## Clean up

```sh
bun alchemy destroy --profile testing
```

See the [vinext guide](https://alchemy.run/cloudflare/frontend/vinext/).

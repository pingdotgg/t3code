# Cloudflare Website: Next.js

Deploys a [Next.js](https://nextjs.org) app to Cloudflare Workers with
`Cloudflare.Website.Nextjs` — the wrangler-free OpenNext pipeline from
`@alchemy.run/frontend-frameworks/nextjs`. No `wrangler.toml` or OpenNext config
is required: the integration runs `next build` through `@opennextjs/cloudflare`, bundles
the resulting worker, and deploys the static assets (including
prerendered pages) alongside it.

- `app/page.jsx` is server-rendered in the Worker on every request and
  reads the `GREETING` binding declared in `alchemy.run.ts` via
  OpenNext's `getCloudflareContext()`.
- `app/api/hello/route.js` is an app-router API route handler.
- Everything under `public/` deploys as static assets.
- Without a native OpenNext config, Alchemy generates temporary read-only
  static-assets defaults. For writable incremental static regeneration, pass
  KV namespaces through `isr`; Alchemy binds them and the revalidation queue
  and selects matching KV adapters.

The integration packages must be installed in the project (the source
provider is loaded dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks @opennextjs/cloudflare
```

## Optional native OpenNext configuration

The same minimal resource works with or without a config file:

```typescript
const site = yield* Cloudflare.Website.Nextjs("Site");
```

Without `open-next.config.ts`, Alchemy uses the temporary defaults described
above; no config file is required. If the file exists under `rootDir` (the
working directory by default), Alchemy loads it through OpenNext's native
compiler and never rewrites it. Native Next.js and Tailwind configs are unchanged.

For example, to keep read-only static-assets caching with a custom build command:

```typescript
// open-next.config.ts
import { defineCloudflareConfig, type OpenNextConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

export default {
  ...defineCloudflareConfig({ incrementalCache: staticAssetsIncrementalCache }),
  buildCommand: "pnpm exec next build",
} satisfies OpenNextConfig;
```

The full native `OpenNextConfig` shape, imports, and callbacks are preserved,
subject to Cloudflare's adapter constraints; AWS-specific runtime features do
not become available on Workers. An explicit resource `openNext.buildCommand`
overrides the file's command. `openNext.minify` and `openNext.debug` remain
resource-level build controls.

With a native config, `isr` still binds the KV namespaces and Durable Object
queue, but does not select adapters for you. Choose `kv-incremental-cache`,
`kv-next-tag-cache`, and `do-queue` in the config to match those bindings.
The static-assets example above is read-only.

## Deploy

```sh
bun run deploy
```

Unchanged sources skip the OpenNext build entirely on subsequent
deploys — the input files are content-hashed (scoped by `memo.include`).
`open-next.config.ts` itself is always hashed. When narrowing `memo.include`,
include any helpers imported by the config too.

## Dev

```sh
bun run dev
```

Local development defaults to the production build served under workerd.
Set `dev: { mode: "hmr" }` on the resource to run `next dev` with hot module
replacement and Worker bindings proxied into `getCloudflareContext()`.

## Destroy

```sh
bun run destroy
```

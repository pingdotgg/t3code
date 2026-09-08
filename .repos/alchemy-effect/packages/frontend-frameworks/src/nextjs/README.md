# @alchemy.run/frontend-frameworks/nextjs

Next.js framework integration for Cloudflare Workers — an OpenNext-based
build pipeline and two dev-server modes, fully **wrangler-free**.

- `build` runs the `@opennextjs/cloudflare` pipeline in a disposable child
  process (no wrangler code is ever imported), performs the final bundle pass
  wrangler would normally do at deploy time, and returns the framework-core
  `BuildOutput` (server modules entry-first + the static-assets directory).
- `dev` starts a local server in one of two modes (`dev.mode`).

## Dev modes

### `"preview"` (default) — production parity, no HMR

Builds the OpenNext worker and serves it under
`@alchemy.run/cloudflare-runtime/core` (workerd) with the OpenNext worker
shape: `ASSETS` (run-worker-first), a `WORKER_SELF_REFERENCE` self service
binding, and the same-script SQLite-backed revalidation-queue Durable Object.
What you run is what you deploy. Any change requires a rebuild.

### `"hmr"` — real `next dev`, Cloudflare bindings proxied

Runs the programmatic `next({ dev: true })` custom-server API (Turbopack HMR)
on an http server this package owns, and opens a `cloudflare-runtime`
platform proxy (our wrangler-free `getPlatformProxy` equivalent) with the
worker's bindings. The proxy's `{ env, cf, ctx }` is planted on
`globalThis[Symbol.for("__cloudflare-context__")]` — the exact contract
`@opennextjs/cloudflare`'s `getCloudflareContext()` reads — and
`vm.runInContext` is patched so edge-runtime middleware/routes see it too.
App code works without `initOpenNextCloudflareForDev()` and without wrangler.

```ts
import * as Nextjs from "@alchemy.run/frontend-frameworks/nextjs";

const layer = Nextjs.make({
  dev: { mode: "hmr" },
  vite: {
    compatibilityDate: "2026-05-12",
    worker: { name: "my-app", bindings: [Text.local("TEST_TEXT", "value")] },
  },
});
```

#### Fidelity: what `"hmr"` mode is NOT

`"hmr"` mode runs your app code in **Node.js** (and Next's edge-runtime VM
sandbox for middleware/edge routes), not in workerd:

- **Cloudflare-specific runtime behavior differs.** workerd APIs, runtime
  limits, `nodejs_compat` shimming, `cloudflare:*` modules, request
  lifecycles (`waitUntil` is a no-op), and the `cf` object (a static mock)
  only behave faithfully in `"preview"` mode.
- **Bindings round-trip over a local proxy.** `env.*` stubs forward method
  chains to a workerd instance hosting the real local bindings. Method
  results must be JSON-compatible values, bytes, dates, streams, or
  `DurableObjectId`s; rich class returns (e.g. `R2Object`) and `connect()`
  are not supported (see `cloudflare-runtime/platform-proxy`). Durable Object
  classes defined in your app cannot run in this mode (the proxy worker does
  not host your compiled code).
- **ISR/caching semantics differ.** `next dev` never uses the OpenNext
  incremental-cache/queue/tag-cache overrides — it uses Next's own dev cache.
  Prerender/ISR behavior, `_next/image` via the `IMAGES` binding, and the
  revalidation queue only exist in `"preview"` (and production).

Rule of thumb: iterate with `"hmr"`, verify with `"preview"`.

## Alchemy source provider

`@alchemy.run/frontend-frameworks/nextjs/source` implements alchemy's `WorkerSourceModule`
contract. The descriptor options (`NextjsSourceOptions`) are JSON-stable and
include `dev.mode` to select the dev-server mode:

```ts
source: {
  provider: "@alchemy.run/frontend-frameworks/nextjs/source",
  options: { dev: { mode: "hmr" } },
}
```

## Notes

- The OpenNext pipeline runs `next build` internally via a child process
  (`runner.mjs`); a `wrangler` stub package (`wrangler-stub/`) satisfies
  OpenNext's version probe without installing wrangler.
- `next` itself is resolved from the _project's_ `node_modules`, never from a
  hoisted sibling.

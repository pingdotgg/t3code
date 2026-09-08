# @fixtures/sveltekit

E2E fixture for `@alchemy.run/frontend-frameworks/sveltekit` — a SvelteKit app built and served
without wrangler:

- **SSR** home page whose `+page.server.ts` load reads a `platform.env` value
  supplied by a `Text.local` binding (and checks `platform.ctx.waitUntil`).
- **Form actions** (`/form`): a named action (`?/greet`) exercised both via
  progressive enhancement (`use:enhance`, no full navigation) and as a plain
  no-JavaScript POST (HTML re-render; kit's CSRF origin check included).
- **Cookies** (`/cookies`): a `+page.server.ts` load that reads and re-sets a
  visit-counter cookie — `Set-Cookie` round-trips through the worker shim and
  kit's dev SSR alike.
- **Binary endpoint** (`/api/binary`): a 256-byte octet-stream response
  asserted byte-for-byte.
- **Route group** (`(marketing)/about`): group layout `+layout.server.ts`
  data rendered by the group layout, with the group segment absent from the
  URL (and the literal `/(marketing)/...` path a 404).
- **`platform.caches`** (`/api/cache`): a cache-aside endpoint over
  `caches.default` — a real cache hit on the second request in both modes
  (live: workerd's Cache API; dev: the platform proxy's in-memory store).
- **Platform bindings** (`/platform`): a `+page.server.ts` load exercising a
  real `KvNamespace` binding (`put`/`get` round-trip through the dev
  platform proxy), the dev `env` literal-override precedence
  (`FIXTURE_OVERRIDE`), and `platform.cf`.
- **Server endpoint** `/api/hello` exercising `cookie` (v2), `uuid`
  (browser/node conditional exports), and `node:crypto` under `nodejs_compat`.
- **Prerendered** page (`/prerendered`) served from static assets, alongside
  SSR routes (prerendered + SSR mix).
- **Client-interactive** counter page (`/counter`) proving hydration.
- **Static asset** (`static/robots.txt`).

- **User-owned `vite.config.ts`** (`/api/user-config`): the fixture carries a
  real Vite config file, exactly like a normal SvelteKit v3 project — the
  user registers `sveltekit(...)` themselves with a kit `alias`
  (`$fixture`), adds their own Vite plugin (a `virtual:fixture-marker`
  module), and even declares a user adapter whose `adapt()` **throws**. The
  integration must load the file natively (alias + virtual module observable
  in live and dev) while replacing the user adapter with the deploy target's
  (a green live build is the proof; a warning is logged).

There is no `svelte.config.js` or `wrangler.json` (kit v3 errors on a
`svelte.config.js`; all kit options live in `vite.config.ts`). The deploy
target's in-memory Cloudflare adapter is injected by
`@alchemy.run/frontend-frameworks/sveltekit` into the user's `sveltekit()` call, and the
worker/preview config comes from `e2e.config.ts` via the harness's
target-scoped carriage (`target.cloudflare.worker` for the worker config,
`target.cloudflare.preview` for the miniflare preview); the deploy target
itself defaults to `@alchemy.run/frontend-frameworks/sveltekit/cloudflare`.

## Commands

```sh
bun run build    # e2e build — kit build + in-memory adapt() + rolldown re-bundle -> dist/build.json
bun run preview  # e2e preview — miniflare over dist/build.json + .svelte-kit/cloudflare assets
bun run dev      # e2e dev --port 3103 — kit's own Vite dev server (Node SSR, proxy-backed platform)
bun run test     # playwright: the same suite against both `live` (miniflare) and `dev`
```

`bun run test` goes through `scripts/e2e.mjs`, which skips the suite on
Windows CI only (runner-level socket exhaustion outside this repo — see the
comment in that file).

## Modes

- **live** — the production path: `Framework.build` produces entry-first
  workerd-ready server modules (the Cloudflare target's rolldown finishing
  pass) and the `.svelte-kit/cloudflare` assets directory; the harness serves
  them with miniflare (assets binding `ASSETS`, worker invoked behind the
  assets router).
- **dev** — SvelteKit's own Vite dev server (Node SSR, full HMR). `platform`
  comes from the deploy target's proxy-backed emulator (see below).

Both modes run the same Playwright suite in `test/smoke.test.ts`, which shares
one worker-scoped server per mode (a single dev server / miniflare instance
for the whole file — do not add per-test servers).

## The dev platform seam

Dev runs kit's Node SSR; the Cloudflare target's adapter `emulate()` serves
`platform` through **cloudflare-runtime's platform proxy** (our wrangler-free
`getPlatformProxy`): a workerd instance hosts the fixture's declared worker
bindings and opens lazily on the first SSR request.

- `platform.env` — every declared binding, callable from Node. `Text`/`Json`
  values are materialised; resource bindings (KV, D1, DO, ...) are lazy
  stubs that round-trip real calls to workerd (`FIXTURE_KV.put/get` in
  `/platform` exercises this). Framework-level `dev.env` literals override
  same-named proxied values (`FIXTURE_OVERRIDE` asserts this).
- `platform.ctx` — wrangler-parity no-op `waitUntil` /
  `passThroughOnException` mock.
- `platform.caches` — **actually round-trips** (in-memory store in the proxy
  worker; wrangler's dev `caches` is a no-op). The suite asserts
  `cached: true` on the second request in _both_ modes.
- `platform.cf` — the same mock object miniflare falls back to (`colo`,
  `country`, ...).
- During prerendering, `platform.env` access **throws** (mirroring upstream):
  prerenderable routes must not depend on request-time bindings.

Inherited proxy limitations (documented in
`cloudflare-runtime/platform-proxy`): binding methods returning rich class
instances (e.g. `R2Object`) are unsupported, intermediate values like
`DurableObjectId` need an explicit `await` before synchronous use, and
`connect()` is unsupported.

## The caches wrapper (live)

In live mode the worker entry is the generated shim from
`@alchemy.run/frontend-frameworks/sveltekit/cloudflare`, which replaces the upstream adapter's
`worktop/cfw.cache` dependency with an inline pragma-cache over
`caches.default`: GET/HEAD responses carrying a `cache-control` header are
cached and served from cache unless the request says `no-cache`;
`Set-Cookie` responses are marked `private=Set-Cookie`. Handlers also receive
the real Cache API via `platform.caches` (what `/api/cache` uses). Endpoint
responses without `cache-control` (e.g. kit's `json(...)`) are untouched by
the pragma-cache.

# @fixtures/sveltekit-spa

E2E fixture for `@alchemy.run/frontend-frameworks/sveltekit` exercising the **pure-SPA path**:
`ssr = false` in the root `+layout.ts`, the adapter's SPA fallback page, and —
the nuance under test — `+server.ts` endpoints that **still run server-side**
even though every page is client-rendered.

Where `fixtures/sveltekit` is SSR-first, this fixture is the inverse:

- `src/routes/+layout.ts` sets `ssr = false` / `prerender = false` for the
  whole app.
- `notFoundHandling: "single-page-application"` in `e2e.config.ts` drives the
  in-memory adapter's fallback generation (`builder.generateFallback` →
  `index.html`) and must flow through to the deployed assets'
  `not_found_handling` (mirrored in the miniflare preview's `assetConfig`).
- A **real user `vite.config.ts`** registers `sveltekit()` with a user alias
  (`$spa` → `src/lib`) the widgets page imports through and a user
  `preprocess` that rewrites a marker rendered by the home page — the file
  must be loaded natively per the user-config principle. There is
  deliberately NO `svelte.config.js`: kit v3 (`3.0.0-next.9`) hard-errors on
  its presence ("svelte.config.js is no longer used") — ALL configuration,
  including Svelte `preprocess`/`compilerOptions`, lives in the
  `sveltekit(...)` call.

## Status: ENABLED

The user-config wave landed (the real `vite.config.ts` below loads natively)
and the worker shim implements the SPA not-found deferral, so the suite runs
ungated: `bun run test` calls `playwright test` directly (12 tests, `live` +
`dev`).

## How the SPA fallback reaches the worker (the deferral contract)

Upstream `@sveltejs/adapter-cloudflare`'s `worker.js` never defers a 404 to
the assets layer — kit's `server.respond` renders its own 404 error page for
unmatched routes, and the configured `assets.not_found_handling` only
applies to requests the worker never sees. Our shim makes the configured
`single-page-application` handling reachable (no new option — see
`packages/sveltekit/src/WorkerShim.ts`): when the adapter is built with
`notFoundHandling: "single-page-application"`, the shim defers to
`env.ASSETS.fetch(req)` — where the asset worker applies
`not_found_handling` and serves the generated `index.html` fallback — iff

- `server.respond` returned **404**, and
- the request is **navigation-shaped**: `GET`/`HEAD` with `Accept`
  containing `text/html`, and
- **no kit route pattern matches** the pathname — the most conservative
  available signal that the 404 is kit's router-level "no route" error
  (upstream has no deferral semantics to mirror, and kit marks router 404s
  with no header). Endpoints only exist on matched routes, so intentional
  endpoint 404s are never deferred; a pattern match whose param matchers
  fail keeps kit's own 404 page.

`notFoundHandling: "404-page"` and the default keep exact upstream behavior
(no deferral). Observable here: a navigation-shaped request for an unknown
path returns the `index.html` shell with **200** in live/preview, while a
non-navigation request (no `Accept: text/html`) still gets kit's 404.

## What the app exercises

- **Client-side routing** between three routes (`/`, `/widgets`, `/about`)
  with a planted `window` marker proving no full navigation occurs.
- **Deep links**: a direct request for `/widgets` returns the app shell (no
  widget markup in the raw HTML — asserted via the `sveltekit-spa-shell`
  marker in `app.html`) and hydrates into the correct view, in both live and
  dev.
- **Universal load, server endpoint** (`/widgets` + `/api/widgets`): the
  `+page.ts` load runs exclusively in the browser (`ssr = false`), while the
  `+server.ts` endpoint it fetches runs server-side and reads a
  `Text.local` binding (`FIXTURE_MESSAGE`) from `platform.env`.
- **SPA fallback / not_found_handling**: an unmatched path
  (`/definitely/not/a/route`) serves the shell and hydrates into kit's
  client-side 404 error view (`+error.svelte`).
- **Direct static asset** serve (`static/robots.txt`).
- **User config honored**: the `$spa` kit alias and the marker preprocessor
  (both declared in the user's `vite.config.ts` `sveltekit(...)` call) are
  observable in the rendered app.

## Commands

```sh
bun run dev       # kit's Vite dev server via the harness (port 3108)
bun run build     # kit build + in-memory adapt() + rolldown pass -> dist/build.json
bun run preview   # miniflare over dist/build.json + .svelte-kit/cloudflare assets
bun run test      # playwright e2e (live + dev)
```

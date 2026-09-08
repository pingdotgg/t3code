# @fixtures/astro-static

E2e fixture for `@alchemy.run/frontend-frameworks/astro` exercising the **fully-static path**:
a real `astro.config.mjs` with `output: "static"`, several prerendered pages,
a sitemap-ish nav linking every page, a `getStaticPaths` dynamic route, a
custom `404.astro`, a client-side island (bundled `<script>` counter), and
`public/` assets.

**THE POINT:** a pure static Astro build should deploy **ASSETS-ONLY** — no
worker at all. `BuildOutput.serverModules` must be `undefined`/empty and every
request (pages, client JS, public assets, the 404 page) must be answered by
the asset layer.

## Status: ENABLED

The assets-only static-output wave landed: the suite runs ungated
(`bun run test` calls `playwright test` directly).

## The assets-only seam

What "assets-only" requires of each layer (mirroring `fixtures/static-website`,
the Vite assets-only fixture):

- **Build (`packages/astro`)**: the inline overlay no longer pins `output`,
  so the config file's `output: "static"` (astro's own default) is honored.
  The integration records the resolved `buildOutput` at `astro:config:done`;
  when it is `"static"` the cloudflare target's `finish` pass drops the SSR
  entry astro bundled for prerendering (`serverModules: undefined`) and the
  `clientDirectory` carries every prerendered page, `404.html` included.
- **Preview (live mode)**: miniflare requires a script even for assets-only
  workers, so the harness (`CloudflareTarget.serve`) detects the module-less
  `BuildOutput`, synthesizes a stub that 500s (any request reaching it is a
  routing bug), and forces `routerConfig.has_user_worker: false` itself —
  the fixture hand-rolls nothing. `assetConfig.not_found_handling:
"404-page"` serves the built `404.html` with status 404.
- **Dev**: `astro dev` renders on demand by design (no prerendering in dev);
  the suite only asserts request-visible behavior there (pages, nav, island,
  404, public assets), not build-frozen HTML.

## What the suite asserts

- prerendered pages served in both `live` and `dev` modes
- full-site navigation through the shared nav
- `getStaticPaths`-enumerated `/blog/[slug]` routes
- the client island hydrates (`#hydrated` flips, counter increments)
- `public/robots.txt` and the custom 404 page (status 404 + content)
- **live only**: two fetches of `/` return byte-identical HTML (build-frozen)
- **live only, the enablement target**: `dist/build.json` has NO server
  modules

## Commands

```sh
bun run dev       # astro dev (port 3107)
bun run build     # astro build -> dist/ + dist/build.json
bun run preview   # miniflare over dist/build.json (assets-only + synthesized stub)
bun run test      # playwright e2e over dev + live
```

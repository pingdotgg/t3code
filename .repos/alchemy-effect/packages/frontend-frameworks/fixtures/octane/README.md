# `@fixtures/octane`

An [OctaneJS](https://octanejs.dev) fullstack app driven by the e2e harness
through `@alchemy.run/frontend-frameworks/octane`.

The project is a stock Octane setup: `octane()` in `vite.config.ts`, routes +
`adapter: cloudflare()` in `octane.config.ts`. The integration adds nothing to
the app — `e2e build` runs the project's own `vite build` (client bundle →
`ssr: true` server sub-build → the adapter emitting `dist/server/worker.js`)
and maps the on-disk output onto the `BuildOutput` contract.

- `e2e build && e2e preview` / Playwright `live` — the adapter-emitted worker
  under miniflare, asset-first with SSR on miss, `nodejs_compat`.
- `e2e dev` / Playwright `dev` — Octane's own Vite dev server (in-process SSR
  middleware). No `context.platform` in dev (upstream limitation), so the
  binding assertions are live-only.

Run the smoke tests with `bun run test` (from this directory).

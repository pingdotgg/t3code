# @fixtures/solid-spa

E2E fixture for a **client-only Solid SPA** (plain Vite + `vite-plugin-solid`

- `@solidjs/router`, no SSR and no worker script) deployed as a Cloudflare
  assets-only site with `not_found_handling: "single-page-application"`.

`e2e.config.ts` declares no `main`: the build output is pure static assets,
and in live mode the harness serves them under miniflare's asset router with
the SPA fallback. In dev mode the Vite dev server's own SPA fallback covers
the same behavior.

## What it exercises

- **SPA fallback** — a raw fetch of an unknown path (`/definitely/not/a/route`)
  returns the app shell (`index.html`) with a 200, and a hard `page.goto` to a
  deep link (`/about`) serves the shell and hydrates the right route.
- **Client-side routing** — navigating between views preserves `window` state
  (no full-page navigation).
- **Hydration / interactivity** — the home page counter.
- **Static assets** — `public/robots.txt` is served directly.
- **Visual snapshot** — the original screenshot spec for `/` and `/about`.

## Commands

```sh
bun run dev      # vite dev server
bun run build    # vite build -> dist/ + dist/build.json
bun run preview  # miniflare over dist/build.json
bun run test     # playwright: live (built assets) + dev
```

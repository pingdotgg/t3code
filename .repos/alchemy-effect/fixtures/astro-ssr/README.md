# @fixtures/astro-ssr

E2e fixture for `@alchemy.run/frontend-frameworks/astro` exercising the **SSR-first path with
an honored user config file**. Where `fixtures/astro` is mostly prerendered
and fully programmatic (no `astro.config.*`), this fixture is the inverse: a
**real `astro.config.mjs`** (`output: "server"`, redirects,
`security.checkOrigin: false`, dev toolbar off) that the integration must load
and respect per the user-config principle, driving an app where every route is
on-demand unless it opts into prerendering.

## Status: ENABLED

The user-config wave landed: the integration loads the project's
`astro.config.*` natively and injects the toolchain as an inline overlay, so
this suite runs ungated (`bun run test` calls `playwright test` directly).

## What the app exercises

- dynamic param routes (`/greet/[name]`) rendered per request — no
  `getStaticPaths`, any param resolves
- per-request middleware (`src/middleware.ts`): fresh `requestId` in
  `Astro.locals` (rendered by every SSR page) mirrored onto `x-request-id` /
  `x-middleware` response headers
- a server-handled form POST (`/feedback`): GET renders the form, POST reads
  `formData()` and re-renders with the echoed message; direct `fetch` POSTs
  rely on the user config's `security.checkOrigin: false`
- an `Astro.session` round-trip (`/session`) via zero-config sessions (KV
  driver, `SESSION` binding auto-provisioned in dev / miniflare KV in live)
- a streaming-friendly page (`/stream`): early chunk flushed before an async
  component boundary resolves
- JSON (`/api/hello`, GET + POST echo) and binary (`/api/binary`) endpoints
- ONE prerendered page (`/about/`, `export const prerender = true`) as the
  hybrid exception — served from assets in production
- a redirect declared in `astro.config.mjs` (`/legacy-greeting` →
  `/greet/astro`) whose target is on-demand, so it must be handled by the
  worker in both dev and live
- a `public/` static asset (`/robots.txt`) and the 404 path for unmatched
  routes

## Commands

```sh
bun run dev       # astro dev with the ssr environment in workerd (port 3106)
bun run build     # astro build -> dist/ + dist/build.json
bun run preview   # miniflare over dist/build.json
bun run test      # playwright e2e over dev + live
```

# @fixtures/waku

E2E fixture for `@alchemy.run/frontend-frameworks/waku` — the wrangler-free [Waku](https://waku.gg)
integration for Cloudflare Workers.

There is no `vite.config.ts` and no `wrangler.jsonc`: `e2e.config.ts`
selects the framework and carries the entire worker configuration in memory
via the target-scoped carriage (`target.cloudflare.worker` for the dev/build
worker config, `target.cloudflare.preview` for the miniflare preview
server). A real `waku.config.ts` DOES exist — the integration loads it
natively (the same `vite.runnerImport("/waku.config")` semantics as waku's
own CLI) and the smoke test asserts both of its user-observable settings:
the `rscBase: "custom-rsc"` override and a user vite plugin's virtual
module rendered by `src/pages/config-marker.tsx`.

## What it exercises

- **SSR / RSC** — `src/pages/index.tsx` is a dynamic page rendered by the
  worker at request time, reading the `MESSAGE` text binding through
  `cloudflare:workers` (workerd module-runner in dev, miniflare in preview).
- **Server actions** — `src/actions.ts` is a `"use server"` module driven by
  `useActionState` in `src/components/GreetingForm.tsx`: the form submission
  round-trips through the RSC endpoint and executes inside the worker (the
  action reads the `MESSAGE` binding to prove it).
- **Dynamic route params** — `src/pages/items/[id].tsx` receives the `[id]`
  segment as a prop and renders at request time.
- **API routes** — `src/pages/_api/echo.ts` exports `GET`/`POST` handlers,
  served at `/echo` (waku strips the `_api` prefix).
- **SSG** — `src/pages/about.tsx` is a static page prerendered at build time
  into `dist/public` (HTML + RSC payload), exercising waku's
  `__WAKU_START_PREVIEW_SERVER__` build path.
- **SSG inside workerd** — `src/pages/ssg-env.tsx` has a **top-level**
  `import { env } from "cloudflare:workers"` and is prerendered at build
  time: the build only succeeds because SSG renders through the cloudflare
  vite plugin's preview mode (the freshly built worker under workerd), and
  the emitted HTML bakes in the real `MESSAGE` binding value.
- **Middleware** — `src/middleware/headers.ts` is a managed-mode middleware
  (collected by waku's server entry via `import.meta.glob`) that sets an
  `x-waku-middleware` response header, asserted in both modes.
- **Client interactivity** — `src/components/Counter.tsx` is a
  `"use client"` component hydrated in the browser.
- **Client state across navigation** — `src/components/NavCounter.tsx` lives
  in the (static) layout; its state must survive waku's client navigation
  because the router keeps the layout mounted while swapping pages.
- **Static assets** — `public/hello.txt` rides along in `dist/public`.

Every behavior is asserted in both Playwright modes (`live` = built worker
under miniflare, `dev` = workerd-backed vite dev server) from one shared
worker-scoped server fixture per mode — no per-test servers.

## Commands

```sh
bun run dev      # waku dev over workerd (port 3101)
bun run build    # programmatic waku build -> dist/ + dist/build.json
bun run preview  # miniflare over dist/build.json
bun run test     # playwright: live (built worker) + dev
```

## SSG-in-workerd note

SSG rendering happens inside **workerd**: the SSG step of `waku build`
boots a `vite preview` server over the same resolved config as the build,
and the cloudflare vite plugin's preview mode serves the freshly built
worker through workerd. A page with a _top-level_
`import { env } from "cloudflare:workers"` (see `src/pages/ssg-env.tsx`)
builds and prerenders with real bindings — vs upstream without
`@cloudflare/vite-plugin`, where SSG falls back to Node and the same import
breaks the build. The guarded dynamic-import pattern in `src/env.ts` is
kept as the portable variant for modules that must also load outside a
Cloudflare environment.

# @fixtures/vocs

E2E fixture for [vocs](https://vocs.dev) (the minimal React documentation
framework) on Cloudflare Workers.

Vocs 2.x is built on **waku**: its `vocs()` vite plugin (public export
`vocs/vite`) composes waku's own `waku/vite-plugins` (environments,
adapter-alias, static-build, ...) with vocs's mdx/config/patch plugins, and it
peer-depends on `waku ^1.0.0-beta.6`. It is _not_ a fully static site: page
bodies are prerendered RSC elements, but the document shell is SSR'd per
request and there are dynamic API routes (`/api/search`, `/api/og`,
`/api/mcp`, `/api/feedback`) — so it runs as a worker.

Vocs does not use waku's `unstable_combinedPlugins`, so the
`@alchemy.run/frontend-frameworks/waku` Framework layer can't drive it directly. Instead,
`@alchemy.run/frontend-frameworks/vocs` provides a first-class Vocs framework
integration and target contract. Its Cloudflare target composes the established
Waku adapter and RSC environment primitives while owning Vocs-specific target
selection, runtime requirements, config bridging, and public exports.

There is no `vite.config.ts` and no `wrangler.jsonc`: `e2e.config.ts` carries
the entire worker configuration in memory; `vocs.config.ts` is vocs's own
(platform-agnostic) docs config.

## What it exercises

- **Worker SSR** — the docs shell (sidebar, layout) is rendered by the worker
  at request time in both dev (workerd module-runner) and preview (miniflare).
- **MDX pages** — `src/pages/*.mdx` with sidebar navigation.
- **Client interactivity** — `src/components/Counter.tsx` is a
  `"use client"` component embedded in MDX, hydrated in the browser.
- **Static assets** — `public/hello.txt` rides along in `dist/public`, next to
  vocs's build-time artifacts (`llms.txt`, `llms-full.txt`).

## Workerd bridges (and why vocs is pinned exactly)

Upstream vocs only ships node/vercel/netlify adapters — nothing targets a
no-fs runtime. Runtime config resolution needs a small bridge, implemented as
the `workerdConfigBridge` Vite plugin in the public Vocs integration:

1. **Runtime config resolution** — vocs's server code calls
   `Config.resolve({ server: true })` per request; in production that branch
   dynamically imports an on-disk `dist/server/vocs.config.js` via
   `import.meta.dirname` (Node server layout), which crashes in workerd. The
   bridge rewrites that branch to import a virtual module which re-exports
   the project's original `vocs.config.*`. Vite therefore loads and bundles
   the config itself, preserving its imports and functions; Alchemy does not
   separately resolve or serialize it.

The transform hard-fails with a descriptive error if the installed vocs no
longer matches the expected internals — which is why `vocs` is pinned to an
exact version. On a bump, re-check the guarded patterns in
`packages/frontend-frameworks/src/vocs/Vocs.ts`.

`nodejs_compat` (not just `nodejs_als`) is required: vocs's server bundle
imports `node:fs` and friends (guarded with try/catch at runtime).

## Commands

```sh
bun run dev      # vocs dev over workerd (port 3105)
bun run build    # programmatic vocs build -> dist/ + dist/build.json
bun run preview  # miniflare over dist/build.json
bun run test     # playwright: live (built worker) + dev
```

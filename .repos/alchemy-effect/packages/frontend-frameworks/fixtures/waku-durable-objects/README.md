# @fixtures/waku-durable-objects

E2e fixture for `@alchemy.run/frontend-frameworks/waku` exercising a **framework site plus the
user's own Durable Objects on the same worker** — the pattern alchemy's
`Website.Vite` supports via its custom `main` entry, carried generically by
framework-core's `DeployTarget.entry` (the user-entry seam; see
`packages/frontend-frameworks/src/core/DeployTarget.ts` and the "user-entry seam"
section of `packages/frontend-frameworks/src/core/README.md`).

The app is a waku site (a dynamic page + a `/counter` API route) whose
`src/worker-entry.ts` is the user's own worker entry: it wraps waku's emitted
fetch handler via `virtual:waku/server-entry` and exports `class Counter`, a
SQLite-backed Durable Object. `e2e.config.ts` declares the namespace
(`durableObjectNamespaces` on the dev worker config, `durableObjects` on the
miniflare preview config) and binds it with
`DurableObjectNamespace.local({ binding: "COUNTER", className: "Counter" })`.

## How the seam works

1. **User `main` precedence** — `target.cloudflare.worker.main`
   (`./src/worker-entry.ts`, resolved against the project root) takes
   precedence over waku's pinned rsc server entry
   (`makeWakuPluginOptions` in `packages/waku/src/cloudflare.ts`). The
   wrapped entry is bundled in the **rsc** environment (waku's entry
   topology `{ entry: "rsc", children: ["ssr"] }` is unchanged).
2. **`virtual:waku/server-entry`** — the stable importable specifier for
   waku's server handler (precedent: React Router's
   `virtual:react-router/server-build`). Resolved by
   `makeWakuServerEntryPlugin` to the installed
   `<wakuDirectory>/dist/lib/vite-entries/entry.server.js`, whose default
   export is the adapter's `ExportedHandler`, in dev and build alike.
3. **Entry-chunk selection** — the target surfaces the config's `main` as
   the generic `DeployTarget.entry` carriage; the platform-neutral framework
   half pins the built user-entry chunk as `serverModules[0]`
   (framework-core's `selectEntryByFacade`), while waku's own
   `server/index.js` remains an ordinary chunk the user entry imports.
4. **Dev** — the cloudflare vite plugin's module runner serves the wrapped
   user entry, so the `Counter` class exists in dev too.

## What the app exercises

- SSR page (`/`) reading the Counter DO at request time (`data-testid=do-count`)
- `/counter` API route: `POST` increments, `GET` reads — asserted to
  increment **across requests**, proving DO instance identity on the same
  worker (live + dev)
- static asset (`/hello.txt`) still served alongside the custom entry
- the `MESSAGE` Text binding through the wrapped handler (framework routes
  unaffected by wrapping)

## Commands

```sh
bun run dev       # waku dev with the rsc environment in workerd (port 3110)
bun run build     # waku build -> dist/ + dist/build.json
bun run preview   # miniflare over dist/build.json
bun run test      # playwright e2e (live + dev)
```

# fixtures/nextjs

E2e fixture for `@alchemy.run/frontend-frameworks/nextjs` — the wrangler-free Next.js
(OpenNext-based) framework integration.

The app exercises the OpenNext long tail:

- an SSR app-router page (`/`, `force-dynamic`)
- an API route (`/api/hello`)
- an API route reading a `Text` binding via `getCloudflareContext()`
  (`/api/binding`)
- an ISR page (`/isr`) — asserts the prerendered payload serves from the
  read-only static-assets incremental cache (revalidation writes are a known
  dev-v1 gap; a writable local cache backend is a later phase)
- an edge middleware rewrite (`/mw-rewrite` → `/api/hello`) plus a response
  header on `/api/*`
- static assets (`public/static.txt` and `_next/static/*` client chunks)
- a client-interactive page (`/counter`) proving hydration

## Commands

```sh
bun run build    # e2e build  — OpenNext pipeline + final bundle pass -> dist/build.json
bun run preview  # e2e preview — miniflare over dist/build.json
bun run dev      # e2e dev --port 3104 — built worker under cloudflare-runtime (workerd)
bun run test     # build + playwright (live = miniflare, dev = cloudflare-runtime)
```

## Notes

- `wrangler` resolves to the inert stub in
  `packages/frontend-frameworks/src/nextjs/wrangler-stub` — only its `package.json` version field is
  ever read (OpenNext's `ensureNextjsVersionSupported`); no wrangler code is
  installed or executed.
- The OpenNext pipeline runs `npx next build` internally (the fixture's own
  `build` script is `e2e build`, which would recurse).
- Dev (default `"preview"` mode) is production parity: the built worker
  served by workerd with `ASSETS` (run-worker-first), `WORKER_SELF_REFERENCE`
  (self service binding), and the same-script SQLite `DOQueueHandler` durable
  object. No HMR.
- `test/hmr.test.ts` exercises dev v2 (`dev: { mode: "hmr" }`): the real
  `next dev` (Turbopack HMR) in Node with the `TEST_TEXT` binding proxied
  from cloudflare-runtime onto OpenNext's `getCloudflareContext()` contract —
  no `initOpenNextCloudflareForDev()`, no wrangler. The spec builds its own
  `Framework` layer (the harness `dev` fixture stays wired to preview mode);
  `scripts/hmr-repro.mjs` is a minimal manual runner for the same path. App
  code runs in Node in this mode — CF-specific behavior and ISR/caching
  semantics still need preview (see `packages/nextjs/README.md`).

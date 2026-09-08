# Cloudflare Website: Next.js

Deploys a [Next.js](https://nextjs.org) app to Cloudflare Workers with
`Cloudflare.Website.Nextjs` — the wrangler-free OpenNext pipeline from
`@alchemy.run/frontend-frameworks/nextjs`. No `wrangler.toml`, no adapter wiring: the
integration runs `next build` through `@opennextjs/cloudflare`, bundles
the resulting worker, and deploys the static assets (including
prerendered pages) alongside it.

- `app/page.jsx` is server-rendered in the Worker on every request and
  reads the `GREETING` binding declared in `alchemy.run.ts` via
  OpenNext's `getCloudflareContext()`.
- `app/api/hello/route.js` is an app-router API route handler.
- Everything under `public/` deploys as static assets.
- `open-next.config.ts` selects the read-only static-assets incremental
  cache: ISR pages serve their prerendered payloads; revalidation writes
  are a no-op (v1 limitation — no KV/R2/D1-backed cache yet).

The integration packages must be installed in the project (the source
provider is loaded dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks @opennextjs/cloudflare
```

## Deploy

```sh
bun run deploy
```

Unchanged sources skip the OpenNext build entirely on subsequent
deploys — the input files are content-hashed (scoped by `memo.include`).

## Dev

```sh
bun run dev
```

Local dev is v1 preview parity: the built worker served under workerd
via `@alchemy.run/cloudflare-runtime/core`. No HMR yet.

## Destroy

```sh
bun run destroy
```

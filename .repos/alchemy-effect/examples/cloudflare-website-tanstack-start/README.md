# Cloudflare Website: TanStack Start

Deploys a [TanStack Start](https://tanstack.com/start) app to Cloudflare
Workers with `Cloudflare.Website.Vite` — no adapter setup or Wrangler
configuration.

- `src/routes/index.tsx` is server-rendered in the Worker and reads the
  `GREETING` env value declared in `alchemy.run.ts` through a server
  function.
- `src/components/Card.tsx` is a React component styled with Tailwind
  utilities, wired through `@tailwindcss/vite` in the project's own
  `vite.config.ts`.
- `src/routes/api.hello.ts` is a server route demonstrating four ways to
  call into the sibling `Backend` Effect worker and its R2 bucket: the
  direct R2 binding, service-binding `fetch`, a typed RPC method, and an
  Effect `HttpClient` over the service binding.
- `src/backend.ts` is that Effect worker — an RPC method plus an HTTP
  handler over `Cloudflare.R2.ReadWriteBucket`.

## Deploy

```sh
bun run deploy
```

## Destroy

```sh
bun run destroy
```

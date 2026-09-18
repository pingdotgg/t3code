# Cloudflare Website: React Router

Deploys a [React Router](https://reactrouter.com) v7 app — in React
Server Components mode — to Cloudflare Workers with
`Cloudflare.Website.Vite`. No Wrangler configuration and no manual
entrypoint: the RSC build emits two server environments (`rsc` and
`ssr`), and `viteEnvironments` in `alchemy.run.ts` tells Alchemy how
they assemble into one Worker.

- `app/routes/home.tsx` is a server component rendered in the Worker on
  every request; it reads the `GREETING` value declared in
  `alchemy.run.ts` from `process.env` (populated by date-default Node.js
  compatibility flag).
- `app/components/Card.tsx` is a React component styled with Tailwind
  utilities (wired through `@tailwindcss/vite` in `vite.config.ts`).
- `react-router-vite/` holds one entry module per Vite environment —
  the browser bundle, the SSR renderer, and the Worker handler.
- Everything under `public/` deploys as static assets.

## Deploy

```sh
bun run deploy
```

Unchanged sources skip the Vite build entirely on subsequent deploys —
the input files are content-hashed (scoped by `memo.include`).

## Destroy

```sh
bun run destroy
```

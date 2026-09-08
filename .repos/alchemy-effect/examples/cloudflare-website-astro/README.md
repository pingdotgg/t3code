# Cloudflare Website: Astro

Deploys an [Astro](https://astro.build) site to Cloudflare Workers with
`Cloudflare.Website.Astro` — no `astro.config.*`, adapter setup, or
Wrangler configuration.

- `src/pages/index.astro` is server-rendered in the Worker on every
  request and reads the `GREETING` binding declared in `alchemy.run.ts`.
- `src/pages/about.astro` opts into prerendering
  (`export const prerender = true`) and is served as a static asset.
- Everything under `public/` deploys as static assets.

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

## Deploy

```sh
bun run deploy
```

Unchanged sources skip the Astro build entirely on subsequent deploys —
the input files are content-hashed (scoped by `memo.include`).

## Destroy

```sh
bun run destroy
```

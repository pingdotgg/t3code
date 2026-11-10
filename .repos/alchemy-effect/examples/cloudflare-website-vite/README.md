# Cloudflare Website: Vite

Deploys a [Vite](https://vite.dev) React SPA to Cloudflare Workers with
`Cloudflare.Website.Vite` — no `main` entry, build command, or Wrangler
configuration. Alchemy runs Vite with the project's own
`vite.config.ts`, merging its Cloudflare integration on top, and serves
the client assets from a Worker. The page renders entirely in the
browser.

- `src/main.tsx` mounts the React app into `index.html`.
- Tailwind CSS v4 is wired through `@tailwindcss/vite` in the project's
  own `vite.config.ts`, which Alchemy loads natively — plugins included.

## Deploy

```sh
bun install
bun run deploy
```

Unchanged sources skip the Vite build entirely on subsequent deploys —
the input files are content-hashed (scoped by `memo.include`).

## Local development

```sh
bun run dev
```

`alchemy dev` runs Vite's own dev server (HMR included) behind Alchemy's
local proxy.

## Destroy

```sh
bun run destroy
```

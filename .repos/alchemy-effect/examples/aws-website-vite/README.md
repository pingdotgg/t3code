# AWS Website: Vite

Deploys a [Vite](https://vite.dev) React SPA to AWS with
`AWS.Website.Vite` — static assets (the `vite build` output) in S3
behind a CloudFront distribution. No server function is created; the
page renders entirely in the browser.

- `src/main.tsx` mounts the React app into `index.html`.
- Tailwind CSS v4 is wired through `@tailwindcss/vite` in the project's
  own `vite.config.ts`, which Alchemy loads natively — plugins included.
- `spa` defaults on, so unmatched paths answer with the index page.

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

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

`alchemy dev` runs Vite's own dev server (HMR included) — no cloud
resources are created.

## Destroy

```sh
bun run destroy
```

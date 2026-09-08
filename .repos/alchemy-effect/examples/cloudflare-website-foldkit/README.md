# Cloudflare Website: Foldkit

Deploys a [Foldkit](https://foldkit.dev) app to Cloudflare Workers with
`Cloudflare.Website.Foldkit` — no `main` entry, build command, or
Wrangler configuration. Foldkit apps are client-only Vite projects:
Alchemy runs Vite with the project's own `vite.config.ts` and serves
the client build as static assets — no Worker code runs at request
time.

- `src/main.ts` holds the Elm-architecture model/update/view; the page
  renders a `card` view function (`src/components/Card.ts`) written in
  plain TypeScript with `foldkit/html`.
- Tailwind CSS v4 is wired through `@tailwindcss/vite` in the project's
  own `vite.config.ts`, alongside `@foldkit/vite-plugin`.
- Unmatched paths serve `index.html` (SPA fallback) by default, so deep
  links boot the app and Foldkit routes on the client.

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

`alchemy dev` runs Vite's own dev server — Foldkit's HMR and devtools
wiring work unchanged.

## Destroy

```sh
bun run destroy
```

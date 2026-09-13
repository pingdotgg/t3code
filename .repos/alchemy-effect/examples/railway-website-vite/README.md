# Railway Website: Vite + Notes API

A Tailwind React SPA (`Railway.Website.Vite`) that reads and writes notes
through an Effect `Railway.Function` (canvas, no registry) persisted on
`Railway.Postgres`.

Alchemy generates a Dockerfile and Railway builds it. No GHCR.

- `alchemy deploy` builds the SPA (inlining `VITE_API_URL`) and deploys
  Postgres + the Function + the static site.
- `alchemy dev` is Vite's own server (HMR included).

```sh
bun run deploy
```

```sh
bun run destroy
```

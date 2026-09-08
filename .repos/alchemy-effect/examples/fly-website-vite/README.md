# Fly Website: Vite + Notes API

A Tailwind React SPA (`Fly.Website.Vite`) that reads and writes notes
through an Effect `Fly.Service`, persisted on `Fly.Postgres`.

- `alchemy deploy` builds the SPA (inlining `VITE_API_URL`) and deploys
  the API Machine + managed Postgres + the static site.
- `alchemy dev` is Vite's own server (HMR included). The API Service
  still deploys (Postgres is live-only).

```sh
bun run deploy
```

The SPA is at `https://{web-app}.fly.dev`. The API is at
`https://{api-app}.fly.dev` (`GET`/`POST /notes`).

```sh
bun run destroy
```

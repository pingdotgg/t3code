# Hetzner Website: Vite + Notes API

A Tailwind React SPA (`Hetzner.Website.Vite`) that reads and writes notes
through an Effect `Hetzner.Service`. Hetzner has no managed Postgres, so
the API stores rows in a [Neon](https://neon.tech) branch.

- `alchemy deploy` builds the SPA (inlining `VITE_API_URL`) onto a `cpx12`
  in `fsn1` and deploys the API unit on the same Server.
- `alchemy dev` is Vite's own server (HMR included).

```sh
export HCLOUD_TOKEN=...
bun run deploy
```

The SPA is at `http://{ipv4}:3000`. The API is at `http://{ipv4}:3001`
(`GET`/`POST /notes`).

```sh
bun run destroy
```

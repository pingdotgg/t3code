# aws-router

Two Vite sites behind one shared `AWS.Website.Router`, mounted on different
paths:

| Path      | Site        |
| --------- | ----------- |
| `/`       | `apps/web`  |
| `/docs/*` | `apps/docs` |

## Local

```sh
pnpm dev
```

`alchemy dev` runs each site's own Vite dev server (HMR included) and serves
the Router from a locally emulated CloudFront on its own port:

```
url    http://localhost:9500
web    http://localhost:5173
docs   http://localhost:5174
```

Open the `url` — `/` and `/docs/` route to the two dev servers through the
emulated edge, running the same CloudFront Function a deploy would. Editing
either app updates instantly; no redeploy, no invalidation.

Requires Docker: the emulator runs as a container that `alchemy dev` starts
for you.

## Deploy

```sh
pnpm deploy
```

Creates a real CloudFront distribution, uploads each site to S3, and serves
both from the same front door. `pnpm destroy` tears it down.

## Notes

The path prefix is not stripped: a site mounted at `/docs` is addressed as
`/docs/...` at the edge, so `apps/docs` sets Vite's `base` to `/docs/` to
match. `apps/web` is at the root and needs no `base`.

Nothing in `alchemy.run.ts` is dev-specific — the same resource graph is
declared in both modes.

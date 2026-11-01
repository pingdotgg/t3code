# GCP Website: Next.js

Deploys a [Next.js](https://nextjs.org) app to Google Cloud with
`GCP.Website.Nextjs`. There is no OpenNext and no Dockerfile. Alchemy runs
`next build`, then bakes `.next/`, `public/`, `next.config.mjs`, and a
small `next({ dev: false })` server into a Node image, with `next`,
`react`, and `react-dom` installed into it. It pushes the image to Artifact
Registry and runs it on a public Cloud Run service.

- `app/page.jsx` is `force-dynamic`, so it is server-rendered in the Cloud
  Run container on every request and reads the `GREETING` environment
  value declared in `alchemy.run.ts`.
- `app/api/hello/route.ts` is an App Router route handler.
- Everything under `public/` is served as static assets. Tailwind compiles
  through the project's own `postcss.config.mjs`.

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

## Deploy

Credentials come from your alchemy profile: run `alchemy profile` once and
pick GCP (*Service account JSON* for a key file, or *Stored* for an access
token or key kept in `~/.alchemy/credentials`, plus a default region), then
deploy with `--profile <name>`. The service runs in the profile's region.

Docker must be running, because the image is built locally.

From the repository root:

```sh
pnpm install
cd examples/gcp-website-nextjs
pnpm deploy --profile <name>
```

The `url` output is the Cloud Run service URL (`https://….run.app`).
Unchanged sources skip `next build` and the image push on later deploys,
because the input files are content-hashed (scoped by `memo.include`).

## Local development

```sh
pnpm dev --profile <name>
```

`alchemy dev` runs `next dev` with hot reload. It creates no Cloud Run
service or image.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts --timeout 1200000
```

[The test](./test/integ.test.ts) deploys the stack and checks the
server-rendered home page, the API route, the compiled Tailwind stylesheet,
and a file from `public/`. At the end it destroys the stack.

## Destroy

```sh
pnpm destroy --profile <name>
```

This deletes the Cloud Run service, its Artifact Registry image repository,
and the service account Alchemy minted for it.

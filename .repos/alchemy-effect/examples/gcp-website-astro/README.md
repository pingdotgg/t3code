# GCP Website: Astro

Deploys an [Astro](https://astro.build) site to Google Cloud with
`GCP.Website.Astro`. You don't need an `astro.config.*` adapter or a
Dockerfile. Alchemy builds the site with Astro's Node target and bakes the
server plus the client assets into a Node image. It pushes the image to
Artifact Registry and runs it on a public Cloud Run service.

- `src/pages/index.astro` is server-rendered in the Cloud Run container on
  every request and reads the `GREETING` environment value declared in
  `alchemy.run.ts`.
- `src/pages/about.astro` opts into prerendering
  (`export const prerender = true`) and is served as a static file.
- Everything under `public/` is served as static assets.

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
cd examples/gcp-website-astro
pnpm deploy --profile <name>
```

The `url` output is the Cloud Run service URL
(`https://….run.app`). Unchanged sources skip the Astro build and the
image push on later deploys, because the input files are content-hashed
(scoped by `memo.include`).

## Local development

```sh
pnpm dev --profile <name>
```

`alchemy dev` runs Astro's own dev server with hot reload. It creates no
Cloud Run service or image.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts --timeout 1200000
```

[The test](./test/integ.test.ts) deploys the stack and checks the
server-rendered home page, the prerendered page, the Tailwind build, and a
file from `public/`. At the end it destroys the stack.

## Destroy

```sh
pnpm destroy --profile <name>
```

This deletes the Cloud Run service, its Artifact Registry image repository,
and the service account Alchemy minted for it.

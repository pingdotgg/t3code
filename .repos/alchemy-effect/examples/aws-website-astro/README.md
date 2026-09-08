# AWS Website: Astro

Deploys an [Astro](https://astro.build) site to AWS with
`AWS.Website.Astro` — no `astro.config.*` adapter setup and no
CloudFormation templates. The server bundle runs on a streaming Lambda
Function URL; static assets deploy to S3 behind a CloudFront
distribution.

- `src/pages/index.astro` is server-rendered in the Lambda on every
  request and reads the `GREETING` environment value declared in
  `alchemy.run.ts`.
- `src/pages/about.astro` opts into prerendering
  (`export const prerender = true`) and is served from S3.
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

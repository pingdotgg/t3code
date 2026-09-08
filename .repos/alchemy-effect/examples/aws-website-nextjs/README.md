# AWS Website: Next.js

Deploys a [Next.js](https://nextjs.org) app to AWS with
`AWS.Website.Nextjs` — the OpenNext (`@opennextjs/aws`) serverless
topology with zero CDK or CloudFormation wiring: the SSR server runs on
a streaming Lambda Function URL, static assets (including prerendered
pages) deploy to S3 behind CloudFront, images are optimized by a
dedicated Lambda at `/_next/image`, and ISR revalidation flows through
an SQS FIFO queue plus a DynamoDB tag-cache table.

- `app/page.jsx` is server-rendered in the Lambda on every request and
  reads the `GREETING` environment value declared in `alchemy.run.ts`
  via `process.env`.
- `app/api/hello/route.ts` is an app-router API route handler.
- Everything under `public/` deploys as static assets.

The integration packages must be installed in the project (the source
provider is loaded dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks @opennextjs/aws
```

`open-next.config.ts` is the minimal default the AWS deploy target
generates when a project has none: the server uses the
`aws-lambda-streaming` wrapper so the emitted handler streams on the
Function URL (`invokeMode: RESPONSE_STREAM`).

> [!NOTE]
> Running this example from inside the alchemy monorepo hits a known
> OpenNext limitation: the repo's bun *isolated* installs store packages
> behind `node_modules/.bun` symlinks, and OpenNext's file trace ships
> the server's `node_modules` as symlinks that the Lambda zip flattens —
> breaking store-sibling resolution (`Cannot find module
> '@swc/helpers/...'` at runtime). A standalone copy of this project
> (plain `bun install`, hoisted `node_modules`) deploys and serves
> correctly.

## Deploy

```sh
bun run deploy
```

Unchanged sources skip the OpenNext build entirely on subsequent
deploys — the input files are content-hashed (scoped by `memo.include`).

## Dev

```sh
bun run dev
```

Local dev is Next's own dev server (`next dev`, native HMR) — no cloud
resources are created.

## Destroy

```sh
bun run destroy
```

# AWS Website: SolidStart

Deploys a [SolidStart](https://start.solidjs.com) app to AWS with
`AWS.Website.SolidStart` — no adapter wiring and no CloudFormation
templates. Alchemy runs the project's own `vite build` and appends
nitro's `aws-lambda` preset: the SSR server runs on a streaming Lambda
Function URL, and client assets are served from S3 behind a CloudFront
distribution.

- `src/routes/index.tsx` is server-rendered in the Lambda on every
  request and reads the `GREETING` environment value declared in
  `alchemy.run.ts` from `process.env`.
- `vite.config.ts` holds only `solidStart()` and the Tailwind plugin —
  no `nitroV2Plugin()`; the deploy target owns the nitro plugin
  instance.
- Everything under `public/` deploys as static assets.

The integration package must be installed in the project (it is loaded
dynamically at deploy time), alongside `@solidjs/vite-plugin-nitro-2`:

```sh
bun add -d @alchemy.run/frontend-frameworks
bun add @solidjs/vite-plugin-nitro-2
```

## Deploy

```sh
bun install
bun run deploy
```

Unchanged sources skip the SolidStart build entirely on subsequent
deploys — the input files are content-hashed (scoped by
`memo.include`).

## Local dev

```sh
npx alchemy dev
```

Runs SolidStart's own Vite dev server — no AWS resources beyond the
state store. SolidStart 2's dev server (via `srvx/node`) misrenders
under Bun, so run `alchemy dev` with Node for this example.

## Destroy

```sh
bun run destroy
```

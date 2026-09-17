# AWS Website: TanStack Start

Deploys a [TanStack Start](https://tanstack.com/start) app to AWS with
`AWS.Website.TanStackStart` — no adapter or deployment preset in
`vite.config.ts` and no CloudFormation templates. The SSR server runs on
a streaming Lambda Function URL; client assets deploy to S3 behind a
CloudFront distribution.

- `src/routes/index.tsx` is server-rendered in the Lambda and reads the
  `GREETING` environment value declared in `alchemy.run.ts` through a
  server function.
- `src/components/Card.tsx` is a React component styled with Tailwind
  utilities, wired through `@tailwindcss/vite` in the project's own
  `vite.config.ts`.

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

## Deploy

```sh
bun run deploy
```

Unchanged sources skip the Vite build entirely on subsequent deploys —
the input files are content-hashed (scoped by `memo.include`).

## Destroy

```sh
bun run destroy
```

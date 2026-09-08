# AWS Website: React Router

Deploys a [React Router](https://reactrouter.com) v7 (framework mode)
app to AWS with `AWS.Website.ReactRouter` — no adapter setup and no
CloudFormation templates. The SSR server runs on a streaming Lambda
Function URL; client assets deploy to S3 behind a CloudFront
distribution.

- `app/routes/home.tsx` is server-rendered in the Lambda on every
  request; its loader reads the `GREETING` environment value declared in
  `alchemy.run.ts` from `process.env`.
- `app/components/Card.tsx` is a React component styled with Tailwind
  utilities (wired through `@tailwindcss/vite` in `vite.config.ts`).
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

Unchanged sources skip the React Router build entirely on subsequent
deploys — the input files are content-hashed (scoped by `memo.include`).

## Destroy

```sh
bun run destroy
```

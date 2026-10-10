# AWS Website: Waku

Deploys a [Waku](https://waku.gg) app to AWS with `AWS.Website.Waku` — no `waku.config.ts` adapter, no CDK.

The resource builds the app with waku's own Vite pipeline and a wrangler-free in-memory AWS adapter: the RSC server bundle deploys on a streaming Lambda Function URL, and the client output (including SSG-prerendered pages and the RSC payloads) deploys to S3 behind CloudFront. Values passed via `env` are readable in server components through waku's `getEnv`.

```ts
const site = yield* AWS.Website.Waku("WakuSite", {
  forceDestroy: true,
  env: {
    GREETING: "Hello from Waku on AWS!",
  },
});
```

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # waku's Vite dev server (HMR)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the server's source provider is loaded from its `/waku` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- Read env via `getEnv` from `waku` (as in `src/pages/index.tsx`) — it is backed by the Lambda's `process.env` at request time and keeps page modules portable across deploy targets.

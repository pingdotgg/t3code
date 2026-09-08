# AWS Website: SvelteKit

Deploys a SvelteKit app to AWS with `AWS.Website.SvelteKit` — no `svelte.config.js` adapter, no CDK.

The resource builds the app with SvelteKit's own Vite pipeline and a wrangler-free in-memory AWS adapter, deploys the server output on a streaming Lambda Function URL, and serves client assets + prerendered pages from S3 behind CloudFront. Values passed via `env` are exposed to server routes through `process.env`.

```ts
const site = yield* AWS.Website.SvelteKit("SvelteKitSite", {
  env: {
    GREETING: "Hello from SvelteKit on AWS!",
  },
});
```

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # SvelteKit's Vite dev server (Node SSR, HMR)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the server's source provider is loaded from its `/sveltekit` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, the site is kit's own Vite dev server (plain Node SSR) — already the AWS Lambda programming model, `process.env` included. No cloud resources are created; wrap the site in `Alchemy.remote()` to deploy the real infrastructure even during dev.

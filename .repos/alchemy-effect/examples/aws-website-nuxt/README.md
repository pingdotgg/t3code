# AWS Website: Nuxt

Deploys a Nuxt app to AWS with `AWS.Website.Nuxt` — no `nitro.preset` edits, no CDK.

The resource builds the app through the project's own `@nuxt/kit` with nitro's `aws-lambda` preset (your `nuxt.config.ts` loads natively), deploys the nitro server bundle on a streaming Lambda Function URL, and serves client assets + prerendered pages from S3 behind CloudFront. Values passed via `env` are exposed to server routes and SSR through `process.env`.

```ts
const site = yield* AWS.Website.Nuxt("NuxtSite", {
  env: {
    GREETING: "Hello from Nuxt on AWS!",
  },
});
```

## Commands

```sh
bun alchemy deploy   # build + deploy
bun alchemy dev      # Nuxt's own dev server (nitro dev, HMR)
bun alchemy destroy  # tear down
```

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project — the server's source provider is loaded from its `/nuxt` export at deploy time.
- Unchanged projects skip the build and deploy entirely (the project tree is content-hashed, respecting `.gitignore`).
- In `alchemy dev`, the site is Nuxt's own dev server (native HMR) and no AWS resources are created; wrap the site in `Alchemy.remote()` to deploy the real infrastructure even during dev.
- Nitro's `isr` route rule is Vercel/Netlify-only and ignored on AWS Lambda — use `prerender` (as `/about` does here) or `cache` route rules instead.
- `test/integ.test.ts` deploys the stack and asserts SSR, the API route, the prerendered page, and static assets over HTTP.

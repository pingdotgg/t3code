# Cloudflare Website: Vocs

Deploys a [Vocs](https://vocs.dev) documentation site to Cloudflare Workers
with `Cloudflare.Website.Vocs`—no Vocs adapter or Wrangler configuration.

The resource runs Vocs' Waku/RSC build, deploys the server runtime as a Worker,
and publishes prerendered pages, generated files such as `llms.txt`, and the
contents of `public/` as static assets.

```ts
const site = yield* Cloudflare.Website.Vocs("VocsDocs");
```

## Commands

```sh
bun run dev      # start Vocs' development server in workerd
bun run deploy   # build and deploy the documentation site
bun run destroy  # tear down the Worker and assets
```

## Project structure

- `vocs.config.ts` is loaded natively by Vocs.
- `src/pages/*.mdx` contains the documentation pages.
- `src/components/Counter.tsx` demonstrates an interactive client component.
- `public/hello.txt` demonstrates static passthrough assets.
- `alchemy.run.ts` declares the `Cloudflare.Website.Vocs` resource.

## Notes

- `@alchemy.run/frontend-frameworks` must be installed in the project; the
  source provider is loaded from its `/vocs` exports at deploy time.
- Node.js compatibility is enabled by the Worker's compatibility date.
- Project inputs are content-hashed, respecting `.gitignore` by default, so
  unchanged projects skip the build and deployment.
- When `vocs.config.ts` uses a custom `outDir`, pass the same value as the
  resource's `outDir` property.

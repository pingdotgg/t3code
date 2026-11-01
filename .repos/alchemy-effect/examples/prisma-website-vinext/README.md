# vinext on Prisma

Deploy a vinext App Router application with `Prisma.Website.Vinext`.
Alchemy builds Vinext programmatically, injects its cache adapter, and runs
vinext's Node server on Prisma Compute's Bun runtime. Deployment configuration
stays on `Website.Vinext`; no Alchemy Vite plugin, Dockerfile, or registry is needed.

```typescript
const site = yield* Prisma.Website.Vinext("Web", {
  env: { GREETING: "Hello from vinext on Prisma!" },
});
```

## Run locally

```sh
bun install
bun alchemy dev
```

The Website runs native `vinext dev` with hot reload and creates no Prisma
resources. Apply `Alchemy.remote()` to use live Compute during development.

## Deploy

Configure [Prisma credentials](https://alchemy.run/prisma/setup), then run:

```sh
bun alchemy deploy
```

The site creates its own database-less project. Use `project` for an existing
project, `domain` for a custom hostname, and `compute` for deployment options.
The routes exercise a rendered home page, request-dependent `/api/hello`,
`/isr`, `/example.json`, and `/robots.txt`.

The default data cache is process-local. Set a redacted `REDIS_URL` for a
persistent shared Redis cache. Prisma.Website does not provision Redis.
`@vercel/nft` packages locally installed runtime dependencies; native addons
must be built for Linux.

## Test and clean up

```sh
bun test test/dev.test.ts
ALCHEMY_PROFILE=testing bun test test/integ.test.ts
bun alchemy destroy
```

The live suite destroys its previous stack before deploying and cleans up
afterward. See the [vinext guide](https://alchemy.run/prisma/frontend/vinext).

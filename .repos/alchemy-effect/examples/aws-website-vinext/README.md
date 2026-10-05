# vinext on AWS

Deploy a vinext App Router application with `AWS.Website.Vinext`.
Production uses a streaming Lambda behind CloudFront, with assets and the data cache in S3.

```typescript
const site = yield* AWS.Website.Vinext("Web", {
  env: { GREETING: "Hello from vinext on AWS!" },
});
```

The example includes client hydration, Home/ISR navigation, an environment-aware
`/api/hello?name=Alchemy` endpoint, ISR, and public assets.
The Website provisions its S3 data-cache bucket automatically.
Alchemy injects the cache adapter automatically. Keep ordinary `vinext()`
configuration in Vite; configure deployment on `Website.Vinext`.

## Run locally

```sh
bun install
bun alchemy dev
```

The Website runs native `vinext dev` with hot reload and creates no cloud
resources. Apply `Alchemy.remote()` to deploy live during development.

## Deploy

Configure [AWS credentials](https://alchemy.run/aws/setup), then run:

```sh
bun alchemy deploy
```

Shared props are `rootDir`, `env`, `memo`, `assets`, `dev`, and `domain`.
The integration package must be installed in the application; it is loaded
at build time.

## Test and clean up

```sh
bun test test/dev.test.ts
ALCHEMY_PROFILE=testing bun test test/integ.test.ts
bun alchemy destroy
```

The live suite destroys its previous stack before deploying and cleans up
afterward. See the [vinext guide](https://alchemy.run/aws/frontend/vinext).

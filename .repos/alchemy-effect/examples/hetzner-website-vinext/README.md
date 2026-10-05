# vinext on Hetzner

Deploy a vinext App Router application with `Hetzner.Website.Vinext`.
Production uses vinext's production Node server in a systemd service on a Hetzner server.

```typescript
const site = yield* Hetzner.Website.Vinext("Web", {
  env: { GREETING: "Hello from vinext on Hetzner!" },
});
```

The example includes client hydration, Home/ISR navigation, an environment-aware
`/api/hello?name=Alchemy` endpoint, ISR, and public assets.
The default cache is process-local. Configure a shared Redis store through `env.REDIS_URL` for persistence across restarts and replicas.
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

Configure [Hetzner credentials](https://alchemy.run/hetzner/setup), then run:

```sh
bun alchemy deploy
```

Shared props are `rootDir`, `env`, `memo`, `assets`, `dev`, and `domain`.
Hetzner additionally requires `zone` for custom domains. The integration
package must be installed in the application; it is loaded at build time.

## Test and clean up

```sh
bun test test/dev.test.ts
ALCHEMY_PROFILE=testing bun test test/integ.test.ts
bun alchemy destroy
```

The live suite destroys its previous stack before deploying and cleans up
afterward. See the [vinext guide](https://alchemy.run/hetzner/frontend/vinext).

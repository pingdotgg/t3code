# Hetzner Website: SolidStart

Deploys a [SolidStart](https://start.solidjs.com) site to Hetzner with
`Hetzner.Website.SolidStart` — no adapter setup in the project config.

The Node adapter bundle runs as a systemd unit on a Hetzner Cloud Server (port 3000).


- `src/routes/index.tsx` is server-rendered on the Hetzner Server and reads `GREETING` from `process.env`.
- `vite.config.ts` holds only `solidStart()` and the Tailwind plugin — no `nitroV2Plugin()`; the deploy target owns the nitro plugin instance.
- Static assets under `public/` deploy with the service.

```ts
const site = yield* Hetzner.Website.SolidStart("Website", {
  env: { GREETING: "Hello from SolidStart on Hetzner!" },
});
```

The integration package must be installed in the project (it is loaded
dynamically at deploy time), alongside `@solidjs/vite-plugin-nitro-2`:

```sh
bun add -d @alchemy.run/frontend-frameworks
bun add @solidjs/vite-plugin-nitro-2
```

## Deploy

```sh
bun run deploy
```

Unchanged sources skip the build entirely on subsequent deploys — the
input files are content-hashed (scoped by `memo.include`).

## Dev

```sh
bun run dev
```

`alchemy dev` runs the framework's own dev server (HMR included) and
no cloud resources are created. SolidStart 2's dev server (via
`srvx/node`) misrenders under Bun, so run `alchemy dev` with Node for
this example.

## Destroy

```sh
bun run destroy
```

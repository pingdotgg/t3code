# Railway Website: SolidStart

Deploys a [SolidStart](https://start.solidjs.com) site to Railway with
`Railway.Website.SolidStart` — no adapter wiring in the project config.
Alchemy runs the project's own `vite build` and appends nitro's Node
preset: the SSR server plus client assets run on one `Railway.Service`.

Alchemy generates a Dockerfile and uploads the build context; Railway builds the image. The Service listens on port 3000.


- `src/routes/index.tsx` is server-rendered on the Railway Service and reads `GREETING` from `process.env`.
- A Tailwind-styled Card component ships with the page.
- `vite.config.ts` holds only `solidStart()` and the Tailwind plugin —
  no `nitroV2Plugin()`; the deploy target owns the nitro plugin
  instance.
- Static assets under `public/` (or `static/`) deploy with the service.

```ts
const site = yield* Railway.Website.SolidStart("Website", {
  env: { GREETING: "Hello from SolidStart on Railway!" },
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
bun install
bun run deploy
```

Unchanged sources skip the build entirely on subsequent deploys — the
input files are content-hashed (scoped by `memo.include`).

## Dev

```sh
bun run dev
```

`alchemy dev` runs the framework's own dev server (HMR included) and
no cloud resources are created.

SolidStart 2's dev server (via `srvx/node`) misrenders under Bun, so
run `alchemy dev` with Node for this example.

## Destroy

```sh
bun run destroy
```

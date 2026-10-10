# Railway Website: TanStack Start

Deploys a [TanStack Start](https://tanstack.com/start) site to Railway
with `Railway.Website.TanStackStart` — no adapter or deployment preset
in `vite.config.ts`. The SSR server plus client assets run on one
`Railway.Service`.

Alchemy generates a Dockerfile and uploads the build context; Railway builds the image. The Service listens on port 3000.


- `src/routes/index.tsx` is server-rendered on the Railway Service and reads `GREETING` from `process.env` through a server function.
- A Tailwind-styled Card component ships with the page.

```ts
const site = yield* Railway.Website.TanStackStart("Website", {
  env: { GREETING: "Hello from TanStack Start on Railway!" },
});
```

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
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
no cloud resources are created.

## Destroy

```sh
bun run destroy
```

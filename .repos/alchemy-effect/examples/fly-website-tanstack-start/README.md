# Fly Website: TanStack Start

Deploys a [TanStack Start](https://tanstack.com/start) site to Fly with
`Fly.Website.TanStackStart` — no adapter setup in the project config.

The Node adapter bundle runs as a Fly Service on a Machine (port 3000).


- `src/routes/index.tsx` is server-rendered on the Fly Machine and reads `GREETING` from `process.env` through a server function.
- A Tailwind-styled Card component ships with the page.

```ts
const site = yield* Fly.Website.TanStackStart("Website", {
  env: { GREETING: "Hello from TanStack Start on Fly!" },
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

# Hetzner Website: TanStack Start

Deploys a [TanStack Start](https://tanstack.com/start) site to Hetzner
with `Hetzner.Website.TanStackStart` — no adapter setup in the project
config.

The Node adapter bundle runs as a systemd unit on a Hetzner Cloud Server (port 3000).


- `src/routes/index.tsx` is server-rendered on the Hetzner Server and reads `GREETING` from `process.env` through a server function.
- `src/components/Card.tsx` is a React component styled with Tailwind utilities.

```ts
const site = yield* Hetzner.Website.TanStackStart("Website", {
  env: { GREETING: "Hello from TanStack Start on Hetzner!" },
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

# Hetzner Website: Foldkit

Deploys a [Foldkit](https://foldkit.dev) site to Hetzner with
`Hetzner.Website.Foldkit` — no adapter setup in the project config.

The SPA is served by a systemd unit on a Hetzner Cloud Server (port 3000).
Foldkit apps are client-only Vite projects, so the deploy is assets-only.

- `src/main.ts` holds the Elm-architecture model/update/view.
- `src/components/Card.ts` is a view function styled with Tailwind utilities.
- Unmatched paths serve `index.html` so deep links boot the app.

```ts
const site = yield* Hetzner.Website.Foldkit("Foldkit");
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

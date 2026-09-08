# Hetzner Website: Vocs

Deploys a [Vocs](https://vocs.dev) site to Hetzner with
`Hetzner.Website.Vocs` — no adapter setup in the project config.

The Node adapter bundle runs as a systemd unit on a Hetzner Cloud Server (port 3000).
The resource runs Vocs' Waku/RSC build and deploys the server runtime plus prerendered pages.

- `vocs.config.ts` is loaded natively by Vocs.
- `src/pages/*.mdx` contains the documentation pages.
- `public/hello.txt` demonstrates static passthrough assets.

```ts
const site = yield* Hetzner.Website.Vocs("VocsDocs");
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

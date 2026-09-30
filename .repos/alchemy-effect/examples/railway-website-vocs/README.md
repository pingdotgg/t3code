# Railway Website: Vocs

Deploys a [Vocs](https://vocs.dev) site to Railway with
`Railway.Website.Vocs` — no adapter setup in the project config.

Alchemy generates a Dockerfile and uploads the build context; Railway builds the image. The Service listens on port 3000.
The resource runs Vocs' Waku/RSC build and deploys the server runtime plus prerendered pages.

- `vocs.config.ts` is loaded natively by Vocs.
- `src/pages/*.mdx` contains the documentation pages.
- `public/hello.txt` demonstrates static passthrough assets.

```ts
const site = yield* Railway.Website.Vocs("VocsDocs");
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

# Railway Website: SvelteKit

Deploys a [SvelteKit](https://svelte.dev/docs/kit) site to Railway with
`Railway.Website.SvelteKit` — no adapter setup in the project config.

Alchemy generates a Dockerfile and uploads the build context; Railway builds the image. The Service listens on port 3000.


- The home page is server-rendered on the Railway Service and reads `GREETING` from `process.env`.
- A Tailwind-styled Card component ships with the page.
- Static assets under `public/` (or `static/`) deploy with the service.

```ts
const site = yield* Railway.Website.SvelteKit("SvelteKitSite", {
  env: { GREETING: "Hello from SvelteKit on Railway!" },
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

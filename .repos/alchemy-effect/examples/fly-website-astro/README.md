# Fly Website: Astro

Deploys an [Astro](https://astro.build) site to Fly with
`Fly.Website.Astro` — no adapter setup in the project config.

The Node adapter bundle runs as a Fly Service on a Machine (port 3000).


- The home page is server-rendered on the Fly Machine and reads `GREETING` from `process.env`.
- A Tailwind-styled Card component ships with the page.
- Static assets under `public/` (or `static/`) deploy with the service.

```ts
const site = yield* Fly.Website.Astro("Astro", {
  env: { GREETING: "Hello from Astro on Fly!" },
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

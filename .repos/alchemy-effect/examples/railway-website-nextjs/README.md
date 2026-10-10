# Railway Website: Next.js

Deploys a [Next.js](https://nextjs.org) site to Railway with
`Railway.Website.Nextjs` — no adapter setup in the project config.

Alchemy generates a Dockerfile and uploads the build context; Railway builds the image. The Service listens on port 3000.


- `app/page.jsx` is server-rendered on the Railway Service and reads `GREETING` from `process.env`.
- `app/api/hello/route.ts` is an App Router API route.
- This is `next build` plus a long-running Node process — not OpenNext.

```ts
const site = yield* Railway.Website.Nextjs("Nextjs", {
  env: { GREETING: "Hello from Next.js on Railway!" },
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

# AWS Website: Foldkit

Deploys a [Foldkit](https://foldkit.dev) app to AWS with
`AWS.Website.Foldkit` — the client build in S3 behind a CloudFront
distribution, no CloudFormation templates. Foldkit apps are client-only
Vite projects, so the deployment is assets-only and never creates a
server function.

- `src/main.ts` holds the Elm-architecture model/update/view; the page
  renders a `card` view function (`src/components/Card.ts`) written in
  plain TypeScript with `foldkit/html`.
- Tailwind CSS v4 is wired through `@tailwindcss/vite` in the project's
  own `vite.config.ts`, alongside `@foldkit/vite-plugin`.
- Unmatched paths serve `index.html` (`spa` defaults on), so deep links
  boot the app and Foldkit routes on the client.

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

## Deploy

```sh
bun install
bun run deploy
```

Unchanged sources skip the Vite build entirely on subsequent deploys —
the input files are content-hashed (scoped by `memo.include`).

## Local development

```sh
bun run dev
```

`alchemy dev` runs Vite's own dev server — Foldkit's HMR and devtools
wiring work unchanged — and no AWS resources are created.

## Destroy

```sh
bun run destroy
```

# Prisma Website: Vite

Deploys a real Vite application with `Prisma.Website.Vite`.

A React counter and a button that fetches `/example.json`. Vite builds a browser-only SPA; no backend or database is needed.

## Infrastructure

`alchemy.run.ts` uses `Prisma.providers()` and `Alchemy.localState()`.
The helper uses the project root by default and creates a Prisma project with
`createDatabase: false` for live deployments. No Docker daemon, registry,
other cloud provider, or Postgres database is required.

The workspace supplies `alchemy` and `@alchemy.run/frontend-frameworks` through
`workspace:*` dependencies. `@vercel/nft` is installed for Prisma artifact tracing.
Install dependencies from the repository root before
running commands in this directory. Authenticate Prisma using the Alchemy profile
you intend to deploy with.

## Deploy

```sh
bun run deploy --profile testing
```

The stack returns `url`. Framework configuration, application sources, and public
assets are included in this example; the Website helper owns the deployment adapter.

## Develop

```sh
bun run dev
```

This runs the local framework dev server without provisioning a Prisma project.

## Verify

```sh
ALCHEMY_PROFILE=testing bun test test/integ.test.ts
```

The integration suite destroys previous stack state, deploys the actual app,
requests its page, verifies the static JSON asset, and destroys the stack.
Set `NO_DESTROY=1` only when intentionally keeping the deployment for inspection.

For browser validation, open the returned URL. Click **count: 0**; it becomes **count: 1**. Click **Load greeting** and check that the greeting appears below the button.
Every app also serves `/example.json` with a framework label and greeting.

## Destroy

```sh
bun run destroy --profile testing
```

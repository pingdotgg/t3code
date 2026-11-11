> Runtime acceptance is pending the Neon deployment and browser checks; this example is not yet verified on Neon.

# Neon Website: Astro

Deploys a real Astro application with `Neon.Website.Astro`.

The default site server-renders Astro pages, exposes `/api/hello`, and includes a browser counter. A second `AstroStatic` site uses `astro: { output: "static" }` with `static-src/`; its URL is returned as `staticUrl`.

## Infrastructure

`alchemy.run.ts` uses `Neon.providers()` and `Alchemy.localState()`.
The helper uses the application root by default. Live deployments without explicit
scope own a Neon Project in Ohio (`aws-us-east-2`), including its normal default
database, and a Node 24 Function. The app does not query that database.
No Docker daemon, container registry, or other cloud provider is used.
Pass an existing `project` or `branch` to reuse it without transferring ownership.

The workspace supplies `alchemy` and `@alchemy.run/frontend-frameworks` through
`workspace:*` dependencies. `@vercel/nft` is installed for Neon artifact tracing.
Install dependencies from the repository root before
running commands in this directory. Authenticate Neon using the Alchemy profile
you intend to deploy with.

## Deploy

```sh
bun run deploy --profile testing
```

The stack returns `url` and `staticUrl`. Framework configuration, application sources, and public
assets are included in this example; the Website helper owns the deployment adapter.

## Develop

```sh
bun run dev
```

This runs the native framework dev server without creating an implicit Website-owned
Neon backend. Explicit backend resources remain live resources. Apply
`Alchemy.remote()` to the Website Effect to deploy a real Function during dev.
Cloud-only `function` and `domain` outputs are absent locally.

## Verify

```sh
ALCHEMY_PROFILE=testing bun test test/integ.test.ts
```

The integration suite destroys previous stack state, deploys the actual app,
requests its page, dynamic endpoint, verifies the static JSON asset, and destroys the stack.
Set `NO_DESTROY=1` only when intentionally keeping the deployment for inspection.

For browser validation, open the returned URL. Click **count: 0**; it becomes **count: 1**. Click **Load greeting** and check that the greeting appears below the button.
Every app also serves `/example.json` with a framework label and greeting.

## Destroy

```sh
bun run destroy --profile testing
```

## Packaging and security

The Function receives a deterministic ZIP with a root Fetch `index.mjs`; it is not a
listening server or S3 website. Runtime dependencies are traced with `@vercel/nft`.
Only traced pnpm dependency files are materialized, with Node 24 resolution hooks
preserving canonical package identity. Native addons require Linux/Node 24 validation
and are currently rejected. `.env` files, credential files, and source maps are excluded.

Framework public environment prefixes are intentionally browser-visible. Keep secrets
out of those variables; `Redacted` protects infrastructure output, not arbitrary
framework build-time substitution. Never put `NEON_API_KEY` in Website `env`.

Optional `domain` registers a custom hostname and returns `domain.cnameTarget`.
Publish a DNS-only CNAME and verify HTTPS independently; registration is not proof
of certificate readiness. Functions have public URLs, so authenticate private
application routes in the handler.

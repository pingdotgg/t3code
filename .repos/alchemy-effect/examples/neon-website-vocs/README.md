> The packaged example deploys to Neon and passes live desktop/mobile counter and guide-navigation checks.

# Neon Website: Vocs

Deploys a real Vocs application with `Neon.Website.Vocs`.

A Vocs documentation site with a guide, generated `/llms.txt`, and an interactive React counter embedded in `/counter` MDX.

The packaged framework integration builds and deploys this example using its persistent local stack state. Live checks pass for desktop/mobile counter hydration and guide navigation, JSON GET/HEAD, and generated `/llms.txt`. The filtered fresh Vocs artifact lifecycle test also passes, including normal teardown. This verifies Vocs, not the full 13-framework live matrix.

An earlier `artifact-browser` probe reported a sensitive-file rejection, but its retained log did not identify the selected file and its build output is no longer available. That historical failure was not reproduced by the actual example deployment. Sensitive dependency selections still fail closed and now report sanitized workspace-relative filenames; no exclusion was bypassed.

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

The stack returns `url`. Framework configuration, application sources, and public
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
requests its page, verifies the static JSON asset, and destroys the stack.
Set `NO_DESTROY=1` only when intentionally keeping the deployment for inspection.

For browser validation, open the returned URL. Open `/counter` and click **count: 0**; it becomes **count: 1**.
Every app also serves `/example.json` with a framework label and greeting.

## Destroy

```sh
bun run destroy --profile testing
```

## Packaging and security

The Function receives a deterministic ZIP with a root Fetch `index.mjs`; it is not a
listening server or S3 website. Runtime dependencies are traced with `@vercel/nft`.
Only traced pnpm dependency files are materialized, with Node 24 resolution hooks
preserving canonical package identity. Vocs configuration is bundled so production
need not load its Vite configuration tooling. Validated Linux ARM64 ELF addons and
shared libraries are accepted; incompatible native binaries remain rejected.
`.env` files, credential files, and source maps remain excluded.

Framework public environment prefixes are intentionally browser-visible. Keep secrets
out of those variables; `Redacted` protects infrastructure output, not arbitrary
framework build-time substitution. Never put `NEON_API_KEY` in Website `env`.

Optional `domain` registers a custom hostname and returns `domain.cnameTarget`.
Publish a DNS-only CNAME and verify HTTPS independently; registration is not proof
of certificate readiness. Functions have public URLs, so authenticate private
application routes in the handler.

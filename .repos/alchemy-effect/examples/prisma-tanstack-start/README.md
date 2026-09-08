# Prisma TanStack Start

Minimal TanStack Start app with Prisma Next queries, Prisma Postgres, and
Prisma Compute managed by Alchemy.

## What It Creates

- A Prisma project.
- The project-owned default `main` branch created by Prisma.
- A Prisma Postgres database attached to `main` via `Prisma.Postgres(...)`.
- A database connection with redacted connection strings.
- A Prisma App.
- A single Deployment built from TanStack Start's `.output` artifact.
- Runtime env vars managed by `Prisma.Compute` in the branch environment and
  snapshotted into each Deployment.
- An optional Prisma App custom domain when `PRISMA_TANSTACK_DOMAIN` is set.
- A Prisma Next contract in `src/prisma/contract.prisma`.
- Generated Prisma Next artifacts in `src/prisma/contract.json` and
  `src/prisma/contract.d.ts`.
- A checked-in, versioned initial migration under `migrations/app/`.
- An opt-in local seed script and server routes that query through
  `@prisma-next/postgres/runtime` without returning database IDs or user data.

Alchemy emits the current contract, transactionally applies checked-in Prisma
Next migrations, and verifies the live schema as an explicit `Command.Exec`
release step before Compute builds the artifact:

```sh
bun run db:migrate
bun run build
```

`migration apply` is idempotent and the strict emit/apply/verify sequence runs
on every deploy, so an unplanned contract change, database restore, or schema
drift (including unexpected extra schema objects) fails the release instead of
being hidden by local memo state. PostgreSQL lock waits are capped at 30 seconds,
statements at five minutes, and Alchemy terminates the entire migration process
group after six minutes. The direct database credential exists only in that
command. Artifact packaging is pure and the
Alchemy process's Prisma Management API credentials are excluded from both the
migration subprocess and the application build. The production deployment
receives only its pooled `DATABASE_URL`. Production deploys never seed or
delete application data. Plan and review versioned migrations in source
control, keep changes backward compatible with the currently promoted
Deployment, and use expand/contract changes when a schema transition spans
releases. The Deployment starts `server/index.mjs` on port `3000`.

## Durable State Prerequisite

This stack always uses `Cloudflare.state()`. Alchemy state is stored in a
Cloudflare Worker backed by a Durable Object with embedded SQLite; its bearer
token and encryption key live in Cloudflare Secrets Store. There is
intentionally no local-state fallback. Alchemy does not currently ship a
Prisma-hosted remote state store, so this example selects the built-in durable
backend explicitly.

Before the first deploy or local development session, make one Cloudflare
account available to every trusted operator and CI runner that will deploy or
destroy this stack, then bootstrap the state store once:

```sh
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
bunx alchemy cloudflare bootstrap
```

Keep those Cloudflare credentials configured for every later dev, deploy, and
destroy command. The default state-store Worker is shared across stacks and
stages; Alchemy scopes this stack's records by stack name and stage.

## Local Dev

```sh
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
bun install
bun run dev
```

`alchemy dev` starts a local Prisma Postgres with `@prisma/dev`, passes
`DATABASE_URL` and `DIRECT_URL` for local migration convenience, runs
`bun run db:setup`, and then starts Vite with `bun run dev:start`. Production
runtime keeps the narrower single-credential contract described below.

Open `http://localhost:3000`.

If port 3000 is busy:

```sh
PRISMA_TANSTACK_DEV_PORT=3011 bun run dev
```

## Prisma Next Workflow

```sh
bun run emit      # regenerate contract.json + contract.d.ts
bunx prisma-next migration plan --name <change> # plan and review a migration
bun run db:migrate # emit, transactionally apply, and verify the live schema
bun run seed       # opt-in demo data; never run by deploy
bun run db:setup   # migrate + demo seed, used by local dev
```

The Vite dev server also auto-emits the contract on edits. The explicit scripts
remain the source of truth for deploys and CI so builds are reproducible.

The runtime uses `pg`, so the example uses `connection.databaseUrl`
to pass the pooled `postgres://` endpoint as `DATABASE_URL`. It explicitly
omits `DIRECT_URL`, duplicate pooled variables, and Prisma resource IDs from the
runtime environment. The schema command receives the direct endpoint only for
the duration of contract application.

## Deploy

```sh
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
export PRISMA_SERVICE_TOKEN="..."
export PRISMA_TANSTACK_APP="my-team-web-production"
bun run deploy --stage production
```

The App name must be stable and unique within the Prisma workspace. The example
defaults it from the Alchemy stage for local use; production and CI should set
`PRISMA_TANSTACK_APP` to a deterministic environment-specific value. The
Project name is provider-generated by default so interrupted creates can be
recovered safely; set `PRISMA_PROJECT` only when an externally fixed Console
name is required.

The deploy output prints the Compute URL. Copy its `url` value before checking
the app:

```sh
URL="https://your-app.prisma.build"
```

To attach a custom domain during deploy, set:

```sh
export PRISMA_TANSTACK_DOMAIN="app.example.com"
bun run deploy --stage production
```

The stack output includes the custom domain status and DNS records to configure.

## Check It

```sh
curl --fail-with-body --show-error "$URL/"
curl --fail-with-body --show-error "$URL/api/health"
```

The health response should include:

```json
{
  "ok": true,
  "database": "ready",
  "configuration": "ready"
}
```

## Destroy

```sh
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
export PRISMA_SERVICE_TOKEN="..."
export PRISMA_TANSTACK_APP="my-team-web-production"
bun run destroy --stage production
```

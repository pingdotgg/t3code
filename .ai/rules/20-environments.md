# 20 — Environment Topology

Canonical rules for environment tiers, names, branch mapping, and the
1:1 relationship between Doppler configs and every external integration
(GitHub, Vercel, Render, Convex, Neon, Better Auth, Sentry, Resend).

This rule is mandatory for tasks that touch environment topology. The planned
`bun preflight` and `/env-audit` enforcement described below treats drift as
`error` once the environment-topology implementation lands.

## Canonical names

Three-letter names are canonical. Long names are accepted aliases on input
only; tooling rewrites to canonical form before any provider call.

| Canonical | Aliases (accepted)                | Forbidden anywhere                                     |
| --------- | --------------------------------- | ------------------------------------------------------ |
| `dev`     | `development`, `develop`, `local` | `qa`, `test`, `int`, `sbox`                            |
| `stg`     | `staging`, `stage`, `pre-prod`    | `uat`, `preview` (preview is its own tier — see below) |
| `prod`    | `production`, `live`              | `master`, `release`                                    |

Preview is **not** a tier. It is an ephemeral instance of `dev` (Stack B) or a
shared `preview` env (Stack A). See § Ephemeral previews.

## Tier count: 2 or 3

A repo declares its tier count in `docs/project.md` under
`Environment tiers: 2` or `Environment tiers: 3`.

| Tiers       | Long-lived envs | When to choose                                                                              |
| ----------- | --------------- | ------------------------------------------------------------------------------------------- |
| 3 (default) | dev, stg, prod  | Any product with external users; regulated workloads (PDPL, IFRS, CBO, MoH); paid customers |
| 2 (opt-in)  | dev, prod       | Internal tools, prototypes, single-developer projects, throwaway demos                      |

`/init-project` asks the operator which tier count to use and writes the
choice to `docs/project.md`. Tooling reads the field; missing field = error.

A 2-tier repo treats `stg` as forbidden — preflight rejects any Doppler
config, Vercel env, Render service, or Neon branch named `stg`.

## Branch ↔ environment mapping (GitFlow-lite)

| Branch pattern                  | Target env        | Trigger             | Approval |
| ------------------------------- | ----------------- | ------------------- | -------- |
| `feature/*`, `fix/*`, `chore/*` | ephemeral preview | PR open             | none     |
| `main`                          | `stg`             | push to main        | CI green |
| `release/*`                     | `prod`            | push to `release/*` | CI green |

Tags on `release/*` (e.g. `v1.4.2`) are the source of truth for prod
deployments. Direct push to `prod` from any other branch is forbidden by
GitHub Environments.

For 2-tier repos, `release/*` deploys directly from `main` is allowed —
there is no `stg` to gate against.

## Per-integration topology

Every long-lived tier maps 1:1 across all integrations. Drift = error.

### Doppler

Project name comes from the `docs/project.md` Doppler project name field.
Configs follow `<app>_<tier>`:

```
<doppler-project>/
  api_dev      api_stg      api_prod
  web_dev      web_stg      web_prod
  www_dev      www_stg      www_prod
```

Per-app `doppler.yaml` selects the dev config by default; CI overrides via
`DOPPLER_CONFIG=<app>_<tier>`.

### Vercel (Stack B)

Vercel only exposes three slots: `development`, `preview`, `production`.
Mapping is fixed:

| Tier | Vercel env                                          |
| ---- | --------------------------------------------------- |
| dev  | `development`                                       |
| stg  | `preview` (with Git-branch protection: only `main`) |
| prod | `production`                                        |

`preview` is forbidden as a template tier name, but it is still the required
Vercel slot name for `stg` because Vercel's environment slots are fixed.

Env variables in each Vercel slot must equal the corresponding Doppler
config — preflight `env/doppler-vercel-parity.ts` checks this.

### Render (Stack A)

One Render service per tier per app:

```
<app>-dev    <app>-stg    <app>-prod
```

Each service's env-group token points to the matching Doppler service
token (`DOPPLER_TOKEN_<TIER>`).

### Convex (Stack B)

Convex has only two long-lived deployments. `dev` doubles as `stg`:

| Tier | Convex deployment                                |
| ---- | ------------------------------------------------ |
| dev  | `dev:<...>`                                      |
| stg  | shares `dev:<...>` (Convex limitation, accepted) |
| prod | `prod:<...>`                                     |

`scripts/sync-env.sh` enforces the shared mapping: `--deployment stg` is
rewritten to `--deployment dev` with a logged note.
It also refuses cross-tier writes when the linked Doppler config suffix does
not match the requested deployment tier, except that 2-tier repos may sync
`dev` and `prod` regardless of the currently linked config.

### Neon (Stack A, cloud)

Branch-per-tier off the Neon project root:

```
neon-project/
  branches/
    dev   stg   prod
```

`DATABASE_URL` per tier points to the matching branch endpoint. Migrations
run dev → stg → prod in order; never skip stg in 3-tier repos.

### Local PostgreSQL (Stack A, dev machine)

DB-per-tier in a single local pgsql instance (chosen for parity with the
Neon branch model and zero Drizzle code changes):

```
<app>_dev    <app>_stg    <app>_prod
```

Connection strings:

```
postgres://localhost:5432/<app>_dev
postgres://localhost:5432/<app>_stg   # only when 3-tier
postgres://localhost:5432/<app>_prod
```

`scripts/setup-local-db.sh` creates all three (or two) idempotently.

### GitHub Environments

GitHub Environments named `dev`, `stg`, `prod` (mirroring tiers).

| Setting            | dev         | stg         | prod                                               |
| ------------------ | ----------- | ----------- | -------------------------------------------------- |
| Branch protection  | none        | `main` only | `release/*` only                                   |
| Required reviewers | 0           | 0           | 0 (per Q7 — opt-in per repo via `docs/project.md`) |
| Wait timer         | 0           | 0           | 0 (per Q7 — opt-in per repo)                       |
| Secrets visibility | dev secrets | stg secrets | prod secrets                                       |

Each env carries its tier-scoped `DOPPLER_TOKEN_<TIER>` and any
provider-specific deploy token (`VERCEL_TOKEN`, `RENDER_API_KEY`, etc.).

### Domains

| Tier        | Web                        | API                            |
| ----------- | -------------------------- | ------------------------------ |
| dev (local) | `https://<app>.test`       | `https://api.<app>.test`       |
| stg         | `https://stg.<app>.<root>` | `https://api.stg.<app>.<root>` |
| prod        | `https://<app>.<root>`     | `https://api.<app>.<root>`     |

`BETTER_AUTH_URL` per tier matches exactly. Mismatch = OAuth breaks
silently — preflight `env/better-auth-url-tier.ts` blocks.

### Sentry, Resend, and other observability

| Service | Env separation                                          |
| ------- | ------------------------------------------------------- | --- | ----- |
| Sentry  | One project; tier set via `SENTRY_ENVIRONMENT=dev       | stg | prod` |
| Resend  | Per-tier API key OR shared key + `X-Entity-Tag: <tier>` |
| pino    | `LOG_LEVEL=debug` (dev), `info` (stg), `info` (prod)    |

## Ephemeral previews

Per-PR isolated envs created on PR open, torn down on close/merge.

| Layer        | Stack A                                                               | Stack B                          |
| ------------ | --------------------------------------------------------------------- | -------------------------------- |
| Web/API host | shared `preview` env (paid PR previews not required)                  | per-PR Vercel preview deploy     |
| Database     | shared `preview` Neon branch + per-PR pgsql schema namespace          | per-PR Neon branch from `prod`   |
| Backend      | n/a                                                                   | per-PR Convex preview deployment |
| Secrets      | reuse `*_dev` Doppler config (no per-PR copy)                         | reuse `*_dev` Doppler config     |
| Domain       | `pr-<n>.preview.<app>.<root>`                                         | `<app>-pr-<n>.vercel.app`        |
| Lifetime     | until PR closes/merges                                                | until PR closes/merges           |
| Teardown     | scheduled cleanup job (Stack A shared env grows; cron resets nightly) | automatic on PR close            |

Stack A PR previews share one `preview` env to avoid Render's paid PR
preview tier; the shared env is reset nightly via a Render cron and the
shared `preview` Neon branch is rebased on `stg` weekly.

## Secret rules per tier

| Rule                                         | dev   | stg      | prod                            |
| -------------------------------------------- | ----- | -------- | ------------------------------- |
| Rotation cadence (warn at)                   | never | 180 days | 90 days                         |
| Auto-generated secrets allowed               | yes   | yes      | no — humans only                |
| Service token write permitted                | yes   | yes      | yes (token must be tier-scoped) |
| `--fix` may overwrite existing               | no    | no       | no                              |
| Auto-copy non-secret vars from previous tier | n/a   | from dev | from stg                        |
| `gitleaks` scan severity                     | warn  | error    | error                           |

"Non-secret" means the key matches the project's allowlist regex in
`scripts/preflight/non-secret-keys.json` (e.g. `LOG_LEVEL`, `SENTRY_ENVIRONMENT`,
`NEXT_PUBLIC_*`). Anything else is a secret and never auto-copied.

## Enforcement

Two invocation paths, same checks:

1. `bun preflight` — full preflight including env/\* checks
2. `/env-audit` — alias for `bun preflight --only=env/*` (faster cycle for
   topology-only review)

Both run on every PR. Auto-fix is enabled by default; preflight runs in
`--fix --write` mode in CI for branches `feature/*`, `--check` only for
branches `main` and `release/*` (no auto-write into protected envs).

### Checks registered (under `env/`)

| Check id                       | What it verifies                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `env/naming.ts`                | All Doppler/Vercel/Render/Neon/GitHub env names ∈ canonical or alias set                                |
| `env/tier-count.ts`            | `docs/project.md` `Environment tiers` field present and matches actual config count                     |
| `env/doppler-configs.ts`       | All required `<app>_<tier>` configs exist; auto-fix creates stubs                                       |
| `env/doppler-key-parity.ts`    | Non-secret key set equal across tiers; auto-fix copies missing non-secret keys with placeholder values  |
| `env/doppler-vercel-parity.ts` | Stack B: Vercel env equals matching Doppler config                                                      |
| `env/render-services.ts`       | Stack A: one Render service per tier per app                                                            |
| `env/convex-deployments.ts`    | Stack B: dev + prod deployments exist; stg-→-dev shadow logged                                          |
| `env/neon-branches.ts`         | Stack A: Neon branch per tier                                                                           |
| `env/local-pgsql-dbs.ts`       | Stack A: local DB-per-tier exists (or `setup-local-db.sh` printed)                                      |
| `env/github-environments.ts`   | GitHub Environments dev/stg/prod exist with correct branch policies                                     |
| `env/better-auth-url-tier.ts`  | `BETTER_AUTH_URL` per Doppler config matches domain pattern for that tier                               |
| `env/sync-env-guard.ts`        | `scripts/sync-env.sh` rejects when linked Doppler config doesn't match `--deployment`                   |
| `env/rotation-age.ts`          | Reads Doppler `created_at`; warns on prod secrets > 90 days, stg > 180                                  |
| `env/ephemeral-teardown.ts`    | Open Vercel previews / Convex preview deployments / Neon branches without matching open PR > 24h = warn |

### Auto-fix scope

`--fix` performs only:

1. Create missing Doppler `<app>_<tier>` configs as empty stubs (no values)
2. Copy missing non-secret keys (and only non-secret keys) from the tier
   below with placeholder values; never copy secret values across tiers
3. Create missing GitHub Environments with correct branch policy
4. Create local pgsql DB-per-tier when on Stack A and operator opts in
5. Stop and print exact provider CLI command for anything else (Vercel
   env writes, Render service creation, Neon branch creation) — never
   touch prod automatically

Auto-fix never:

- writes secret values
- overwrites an existing key in any tier
- creates resources in prod without TTY confirmation
- runs in CI on `main` or `release/*` branches

## Adoption / migration

Existing repos derived from this template before rule 20 landed will
report at least:

- `env/tier-count.ts` = `error` (field missing in `docs/project.md`)
- `env/doppler-configs.ts` = `error` for missing stg/prod configs

`bun preflight --fix` resolves both via stub creation. Any failure to
auto-create requires an operator to run the printed CLI command.

## Cross-references

- `.ai/rules/14-secret-management.md` — Doppler is SSOT, rotation, gitleaks
- `.ai/rules/16-deployment.md` — provider deploy mechanics
- `docs/project.md` — `Environment tiers` field, services table
- `scripts/sync-env.sh` — Stack B Doppler→Convex sync (env-guard added by this rule)
- `scripts/preflight/checks/env/*` — implementation
- `docs/tasks/environments-topology.md` — implementation plan

## Checklist (for any task touching environments)

- [ ] `docs/project.md` `Environment tiers` field set (2 or 3)
- [ ] All required Doppler `<app>_<tier>` configs exist
- [ ] Vercel/Render/Convex/Neon/GitHub envs match canonical names
- [ ] `BETTER_AUTH_URL` per tier matches domain pattern
- [ ] Non-secret key set equal across tiers
- [ ] Ephemeral preview teardown working (verified via `env/ephemeral-teardown.ts`)
- [ ] No `qa`/`uat`/`test`/`preview` env names outside the ephemeral preview slot
- [ ] `/env-audit` green on the PR

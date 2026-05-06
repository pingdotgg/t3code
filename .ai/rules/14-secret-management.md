# 14 — Secret Management

Doppler is the single source of truth for all secrets.
Never hardcode secrets. Never commit `.env*` files (except `.env.example` with placeholders).

## Doppler setup

```bash
# Install
brew install dopplerhq/cli/doppler

# Authenticate
doppler login

# Link project (run once per app)
doppler setup --project my-project --config development
```

## Per-app config (monorepos)

Each app has its own `doppler.yaml`:

```yaml
# apps/api/doppler.yaml
setup:
  project: my-project
  config: api_development

# apps/web/doppler.yaml
setup:
  project: my-project
  config: web_development
```

## Running with secrets

```bash
# Development (single app)
doppler run -- bun dev

# Or pull to .env.local (do not commit)
doppler secrets download --no-file --format env > .env.local
```

## Config environments

| Doppler config  | Environment       |
| --------------- | ----------------- |
| `*_development` | Local dev         |
| `*_staging`     | Preview / staging |
| `*_production`  | Production        |

## Convex secret sync (Stack B)

No Doppler MCP available. Use the provided script:

```bash
# Dry run
scripts/sync-env.sh --deployment prod --dry-run

# Apply (pushes to Convex via npx convex env set)
scripts/sync-env.sh --deployment prod
```

The script filters `DOPPLER_*`, `VERCEL_*`, `GITHUB_*` automatically.
Before any sync, it reads the linked Doppler config and refuses cross-tier
writes. For example, a repo linked to `*_dev` cannot run
`scripts/sync-env.sh --deployment prod`. In Stack B, `--deployment stg` is
rewritten to `dev` with a stderr note because Convex staging shadows the dev
deployment. The rejection message names only config/deployment tiers and must
never print secret values.

Run `bun preflight --only=env/*` or `/env-audit` before syncing tier secrets.
For fixable gaps, use `bun preflight --fix --write` from a `feature/*` branch.
The fix engine may create safe missing stubs, generate `BETTER_AUTH_SECRET`,
derive `BETTER_AUTH_URL`, and then re-run `scripts/sync-env.sh` for Stack B.
It must never overwrite existing secret values, print secret values, or perform
production writes from a non-interactive shell.

## Render secret sync (Stack A)

Use Render's dashboard or CLI to set environment variables per service.
In CI, use a Doppler service token:

```yaml
# .github/workflows/deploy.yml
- name: Deploy to Render
  env:
    DOPPLER_TOKEN: ${{ secrets.DOPPLER_SERVICE_TOKEN }}
  run: doppler run -- render deploy
```

## Doppler to GitHub Actions secrets

Security CI reads GitHub Actions secrets, but Doppler remains the source of
truth. Sync only the required names:

- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for optional AI review
- `SEMGREP_APP_TOKEN` for optional Semgrep Cloud upload
- `SLACK_SECURITY_WEBHOOK` for optional failure notifications

```bash
doppler secrets get ANTHROPIC_API_KEY --plain | gh secret set ANTHROPIC_API_KEY
doppler secrets get SEMGREP_APP_TOKEN --plain | gh secret set SEMGREP_APP_TOKEN
doppler secrets get SLACK_SECURITY_WEBHOOK --plain | gh secret set SLACK_SECURITY_WEBHOOK
```

Skip optional secrets that are not used by the derived repo.

## Secret rotation

- Rotate on: team member offboarding, suspected breach, quarterly audit
- After rotation: update Doppler first, then redeploy all affected services
- Document rotation in incident log (`.local/incidents/`)

## Checklist

- [ ] No secrets in code, commits, PR text, or CI logs
- [ ] `.env*` in `.gitignore` (except `.env.example`)
- [ ] Doppler service tokens used in CI (not personal tokens)
- [ ] `bun preflight --only=env/*` or `/env-audit` artefact reviewed for any env/secrets PR
- [ ] gitleaks configured to scan pre-commit — see `13-security.md`
- [ ] `.env.example` kept up to date with all required variable names (no values)

## Cross-references

- Environment tier naming and drift rules: `20-environments.md`

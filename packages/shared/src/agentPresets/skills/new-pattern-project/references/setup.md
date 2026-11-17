# Go Fast Stack setup

Read the template's README, AGENTS.md, CONTEXT.md, `docs/development.md`, Makefile and `mise.toml` before bootstrapping. The public template is [Go Fast Stack](https://github.com/jayleaton/go-fast-stack).

## Decisions

Reuse supplied values for directory slug, display name, destination (default `~/Documents/projects`), Go module path, repository owner/name and visibility. GitHub authentication alone does not authorize creating or pushing a repository. Use `--skip-github` for local-only work. The module path defaults to `github.com/<owner>/<repo>` when an owner is supplied, otherwise `example.com/<slug>`; choose the eventual import path before publishing.

Resolve `SKILL_DIR` from the currently loaded SKILL.md's directory, including its bundled resources. Do not use an unrelated source checkout.

```sh
node "$SKILL_DIR/scripts/bootstrap-go-fast-project.mjs" \
  --project-name invoice-agent \
  --display-name "Invoice Agent" \
  --module-path example.com/invoice-agent \
  --projects-dir ~/Documents/projects \
  --skip-github
```

To create and push an authorized repository, omit `--skip-github` and supply `--github-owner <owner>`, `--repo-name <name>` and `--visibility private` or `public`. Private is the default. `--template <URL-or-local-path>` is available for a fork or fixture; inspect any alternate template first.

## What the helper does

It refuses an existing destination, clones the template, removes its origin, reads the root Go module path, replaces that prefix in the root and nested modules and their imports, updates deployment project names and the optional mobile app's package/Expo identifiers, and sets APP_NAME/ADMIN_APP_NAME in `.env.example`. It keeps toolchain pins, lockfiles, attribution and license files. It commits the named scaffold on `main`, then creates/pushes a repository only when requested. A failure leaves the new directory for inspection; it never removes someone else's directory.

It does not set global package-manager versions or install Node packages at the repository root. `--install` runs `go mod download` in the Go modules; `--verify` runs `make lint`, `make test` and `make build`. These may download tools and need Docker for the checkout's test Postgres, so use the configured isolated compute environment, if any. Go, Git and Make are needed; `mise install` supplies the template's pinned Go version. GitHub publication additionally needs authenticated `gh` and Git author configuration.

## Verify and start

- Read `go.mod` and nested `go.mod` files; search for the old module prefix in imports, generated Go/templ files and scripts. Review any historical documentation matches before replacing them.
- Inspect `.env.example`, `deploy/platform.yaml`, and `apps/mobile-app/package.json` and `app.json` for the requested names. Check `git remote -v` and `git status --short` directly.
- Verify with the new repo's own verification skill.
- For web development, follow the new repo's AGENTS.md and development runbook. Never point at a production database, and stop task-owned databases when finished.
- Mobile is optional and standalone. Follow `apps/mobile-app/README.md`, its Node engine and pinned packageManager. Install there, then run its lint, typecheck, tests and Expo dependency check when mobile changes. Configure EXPO_PUBLIC_API_URL to a server origin reachable by the device; do not impose pnpm or Next.js on the Go server.
- Production email, Railway and Doppler are optional integrations, not bootstrap prerequisites. Deployment needs separate authorization and the template's deployment runbook.

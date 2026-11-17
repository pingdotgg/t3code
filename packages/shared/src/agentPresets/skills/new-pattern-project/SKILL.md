---
name: new-pattern-project
description: Bootstrap a named Go + Datastar project from Go Fast Stack and verify its module paths, naming, repository and checks.
---

# New Pattern Project

Use this when the requested starting point is the public [Go Fast Stack template](https://github.com/jayleaton/go-fast-stack). Reuse the requested slug, display name, destination, visibility and repository intent. Default destination is `~/Documents/projects`; respect another requested location.

Read [setup.md](references/setup.md) and inspect [bootstrap-go-fast-project.mjs](scripts/bootstrap-go-fast-project.mjs) before execution. The helper clones the template, rewrites Go module references and product names, commits the scaffold, and can create/push a GitHub repository. Use `--skip-github` unless publication is authorized. It never overwrites an existing directory. Dependency downloads and checks require `--install` and `--verify`; run those in the configured isolated compute environment, if any.

Follow the cloned repository's AGENTS.md, CONTEXT.md, mise.toml and Makefile. This is a Go server with Datastar and Postgres, not a Node web workspace. Keep the pinned Go and Go-tool versions. Node and pnpm apply only to the optional standalone Expo app in `apps/mobile-app`.

Verify all Go module/import prefixes, display names, mobile identifiers and deployment project names agree; the template remote must be removed or replaced. Verify with the new repo's own verification skill. Do not run deployment targets merely to verify a scaffold.

Proceed to the requested first workflow. Clarify only material product constraints; scaffolding does not require a mandatory interview.

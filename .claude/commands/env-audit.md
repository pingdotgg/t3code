---
description: Run environment-topology preflight checks only.
argument-hint: [--fix] [--write]
---

Run the environment audit for the current repo.

Use `$ARGUMENTS` as additional flags.

Steps:

1. Read `AGENTS.md`, `docs/project.md`, `.ai/rules/14-secret-management.md`,
   and `.ai/rules/20-environments.md`.
2. Run:
   ```bash
   bun preflight --only='env/*' $ARGUMENTS
   ```
3. On `feature/*` branches, `--fix --write` may be used to create safe stubs
   and update local project metadata. On `main` and `release/*`, run check-only.
4. If any check returns `error`, stop and summarize the failed tier or provider
   contract.
5. Reference `.local/preflight/latest.md` and `.local/preflight/latest.json`
   in any environment, secret, deployment, or CI PR.

Success banner:

- EN: Env audit passed
- AR: اكتمل تدقيق البيئات

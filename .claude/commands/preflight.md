---
description: Run stack-aware integration preflight and write .local/preflight artefacts.
argument-hint: [--fix] [--write] [--only=<ids>] [--skip=<ids>]
---

Run the integration preflight for the current repo.

Use `$ARGUMENTS` as additional flags.

Steps:

1. Read `AGENTS.md`, `docs/project.md`, and the relevant stack rule.
2. Run:
   ```bash
   bun preflight $ARGUMENTS
   ```
3. If the report has `error` results, stop and summarize the failing checks.
4. If the report has only `warn` / `info` / `skip` results, summarize them as
   follow-ups.
5. Reference `.local/preflight/latest.md` and `.local/preflight/latest.json`
   in any infrastructure-touching PR.

Success banner:

- EN: Preflight passed
- AR: اكتمل الفحص المسبق

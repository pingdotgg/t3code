# Bugbot Project Brief

## Repository Context

- **Repository mode**: product
- **Team/owner**: MohAnghabo
- **Default branch**: main

## Review Priorities (highest first)

1. Secret, token, credential, or real PII exposure in code, logs, fixtures, screenshots, comments, or docs.
2. Unsafe local command execution, missing confirmation gates, cwd escape, timeout gaps, or weak redaction.
3. GitHub Projects/task-state drift, duplicated task state, or writes that bypass confirmation.
4. PR watcher or auto-fix behavior that can spam comments, repeat commits, or run on untrusted signals.
5. Missing AR/EN strings or RTL regressions in user-facing UI.
6. Regressions to T3 Code package boundaries, provider session reliability, WebSocket event handling, or desktop startup flow.
7. Flag PRs that remove or bypass `bun preflight`, the `preflight` command, `/preflight`, or bootstrap enforcement.
8. Flag non-trivial PRs that omit GitHub issue linkage or fail to update the linked durable spec execution log.

## Focus Paths

- Include: `apps/**`
- Include: `packages/**`
- Include: `scripts/**`
- Include: `.github/**`
- Include: `.ai/rules/**`
- Include: `docs/**`
- Exclude: `apps/**/dist/**`
- Exclude: `packages/**/dist/**`

## Bugbot Expectations

- Flag high-confidence bugs, security issues, and reliability risks first.
- Avoid low-signal style-only comments unless they can cause defects.
- Re-check existing PR comments to avoid duplicates.
- Prefer actionable fixes with concrete code-level guidance.

## Blocking Rules

- No secrets or real PII in code, logs, fixtures, docs, screenshots, comments, or PR text.
- No unsafe GitHub Actions patterns using untrusted event input in shell commands.
- No project rule regressions in `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.ai/rules/*`.
- No removal of required validation, PR readiness, preflight, or env-audit surfaces without an explicit replacement in the same PR.

## Project Constraints

- TypeScript strict mode; no `any`.
- Zod or Effect Schema at runtime boundaries, following the local package pattern.
- Keep changes small, reversible, tested, and documented.

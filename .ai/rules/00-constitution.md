# 00 — Constitution

Non-negotiable rules. Apply to every task, every stack.

## Code quality

- `any` is banned — use `unknown` with type guards
- `class-validator` is banned — Zod only
- TypeScript strict mode always on (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- No hardcoded secrets — Doppler only; see `14-secret-management.md`
- Conventional Commits: `feat|fix|chore|docs|refactor|test|perf|ops`
- No `--no-verify` or `--no-gpg-sign` unless user explicitly requests

## Data & privacy

- **PDPL (Royal Decree 6/2022)** applies to every project — see `15-pdpl-compliance.md`
- No real PII in tests, logs, commits, PR text, or screenshots — use synthetic/anonymized data only
- Arabic-language privacy notices are mandatory (PDPL Art. 4)

## i18n

- AR (Arabic) and EN (English) strings required for every user-facing change
- RTL layout required wherever Arabic strings render
- Reference: `09-next-intl-i18n.md`

## Auth

- Better Auth **v1.4** is pinned — do not upgrade to 1.5 without reading migration notes
  - 1.5 breaking: drizzle-adapter extracted to `@better-auth/drizzle-adapter`, InferUser/InferSession removed, API Key plugin moved to `@better-auth/api-key`, `$ERROR_CODES` type changed to `RawError`
- `BETTER_AUTH_URL` must match the exact request origin and be in `trustedOrigins`

## Output rules

- Non-code files (reports, docs, analysis, temp outputs) → `.local/`, never project root
- PRs ≤ 400 LOC excluding generated files — split scope and open follow-up issue if larger
- Generated files (Zod schemas, HTTP clients) must never be edited by hand

## Validation

Run before every commit:

```bash
bun check   # types + lint + tests — fix failures, do not skip
```

If CI fails on a clean check, investigate before bypassing.

# Review Brief

## Review Scope

- **Repository type**: product
- **Current priority**: security / reliability / developer-experience
- **Review depth**: standard

## Risk Profile

- **Critical surfaces**: local command execution, GitHub Projects writes, issue/PR comments, PR watcher polling, agent workflow launchers, git staging, artifact edits, audit logs, secret redaction, CI workflows.
- **Primary failure modes**: secret leakage, unsafe command execution, incorrect GitHub Project state, noisy or duplicated PR comments, auto-fix loops, stale task state, unreviewed governance drift.
- **Threat model notes**: local-first v1 avoids hosted token storage, but CLI output and audit logs must be treated as sensitive and redacted before display or persistence.

## Quality Gates

- **Blocking criteria**: real PII or secrets, unredacted command logs, bypassed confirmation gates for mutations, GitHub Projects state split from app-local task state, missing AR/EN strings for user-facing UI, failing validation, undocumented governance drift.
- **Non-blocking criteria**: optional provider setup states for Doppler, CodeRabbit, Vercel, and Render when the UI degrades clearly.
- **Required tests before merge**: focused unit tests for contracts and state transitions; Playwright smoke tests for major mock UI screens once UI work begins; fixture tests for real integrations when introduced.
- **Preflight artefacts**: infra, CI, secret, deployment, or environment PRs must reference `.local/preflight/latest.md` or `.local/preflight/latest.json` from `bun preflight`.
- **Env audit artefacts**: changes touching Doppler, GitHub Environments, Vercel, Render, or environment-tier policy must reference `/env-audit` output.
- **Task linkage**: non-trivial PRs must link the GitHub issue and, when a durable spec exists, the `docs/tasks/<name>.md` path.

## Review Preferences

- **Comment style**: concise
- **Findings threshold**: medium+
- **Preferred output format**: findings-first

## Tooling Context

- **Primary CI workflows**: CI, pr-readiness, ai-review
- **Static analysis tools**: oxlint, TypeScript, Vitest, Playwright, preflight, env-audit
- **AI review tools in use**: CodeRabbit and optional AI loop workflows, disabled until configured

## Must-follow Project Rules

- GitHub Projects is the live Kanban/task status SSOT.
- AR/EN for every user-facing string and RTL verification wherever Arabic renders.
- PDPL data minimization and no real PII.
- Redact CLI output before UI display, GitHub comments, audit logs, fixtures, and screenshots.
- Preserve T3 Code package boundaries unless the durable spec explicitly changes them.
- Keep PRs small and independently reviewable; document any necessary exception.

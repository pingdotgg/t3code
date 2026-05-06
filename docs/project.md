# Project Brief

## Identity

- **Product name**: Kanban Console
- **One-liner**: Local desktop/web console for managing GitHub Projects Kanban, monorepo git state, PR health, product docs, and agent workflows for one GitHub owner.
- **Stack**: T3 Code fork — React/Vite web UI, Node.js WebSocket server, Electron desktop shell, Effect Schema contracts. Stack A/B do not apply to this product fork unless a future phase explicitly changes the architecture.

## Domains

- **App name**: kanban-console
  - Local: `http://localhost:3000` or the T3 Code dev-server origin selected by the workspace
  - Production: Not planned for v1; local-first desktop/web console
- **Doppler project name**: kanban-console

## Environments

- **Environment tiers**: 2
  - Local-first v1 uses `dev` and `prod` configuration surfaces only. Add `stg` before hosted deployment workflows are introduced.

## Users & language

- **Primary users**: Maintainers managing multiple monorepos under one GitHub owner.
- **i18n**: AR + EN
- **RTL required**: Yes

## Regulatory and reporting scope

PDPL (Royal Decree 6/2022) always applies. Additional regulators:

- [ ] TRA — Telecom Regulatory Authority
- [ ] CDC — Royal Decree 64/2020 (government agencies / critical national infrastructure)
- [ ] CBO — Central Bank of Oman (fintech)
- [ ] FSA — Financial Services Authority (capital markets)
- [ ] MOH — Ministry of Health (health data)
- [x] None beyond PDPL

Financial reporting standards:

- [ ] IFRS Accounting Standards — full IFRS financial reporting, audit-ready statements, or accounting-system features
- [x] No financial reporting standard selected

## Services

| Service    | Purpose                                                 | Status                                           |
| ---------- | ------------------------------------------------------- | ------------------------------------------------ |
| GitHub     | Repositories, Issues, Projects, PR comments, and checks | required; `gh auth` needed for real integrations |
| Doppler    | Secret management for managed repos that need secrets   | setup-required                                   |
| CodeRabbit | Review signal source                                    | setup-required                                   |
| Vercel     | Deployment readiness for managed repos using Vercel     | optional/setup-required                          |
| Render     | Deployment readiness for managed repos using Render     | optional/setup-required                          |
| Bun        | Local validation and package scripts                    | required                                         |

## Key constraints for this project

- Product implementation must stay in this T3 Code fork, not in the governance template repo.
- GitHub Projects is the task-status SSOT.
- `docs/tasks/*.md` is reference-only inside the app.
- First product milestone is a full clickable mock UI with no real integrations.
- Every user-facing string needs EN and AR translations, with RTL verification for Arabic.
- No real PII, secrets, tokens, raw credentials, or unredacted command logs in tests, fixtures, screenshots, comments, PR text, or audit exports.
- Mutating GitHub, git, CLI, artifact, and agent actions require confirmation; destructive actions require a second confirmation.

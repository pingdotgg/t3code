# .ai/rules — Rule Map

Tool-agnostic guidance files. Readable by Claude Code, Cursor, Codex, OpenCode, Gemini, and others.

## Always active

| File                         | When to load                                                           |
| ---------------------------- | ---------------------------------------------------------------------- |
| `00-constitution.md`         | Every task — non-negotiables                                           |
| `17-aws-well-architected.md` | Every non-trivial task — architecture, implementation, and review lens |
| `18-pr-readiness.md`         | Every PR, review, ship, and merge task — docs, tests, and CI gates     |

## Stack-specific (load one)

| File                   | When to load                           |
| ---------------------- | -------------------------------------- |
| `01-stack-a-nestjs.md` | NestJS + Drizzle + PostgreSQL → Render |
| `01-stack-b-convex.md` | Convex → Vercel                        |

## By task area

| File                        | When to load                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `02-openapi-contracts.md`   | Any API change (Stack A)                                                                                                            |
| `03-better-auth.md`         | Auth flows, session management, user management                                                                                     |
| `04-drizzle-orm.md`         | Database schema, migrations, queries (Stack A)                                                                                      |
| `05-nestjs-patterns.md`     | NestJS modules, guards, pipes, interceptors (Stack A)                                                                               |
| `06-convex-patterns.md`     | Convex schema, functions, real-time (Stack B)                                                                                       |
| `07-vite-react-spa.md`      | apps/web (React SPA, logged-in app)                                                                                                 |
| `08-nextjs-www.md`          | apps/www (Next.js marketing site)                                                                                                   |
| `09-next-intl-i18n.md`      | Any user-facing text (AR/EN, RTL)                                                                                                   |
| `10-error-handling.md`      | Error boundaries, Problem+JSON, retry logic                                                                                         |
| `11-testing.md`             | Unit, integration, E2E, accessibility tests                                                                                         |
| `12-telemetry.md`           | Sentry, pino, OTEL, SLOs                                                                                                            |
| `13-security.md`            | OWASP, ZAP, headers, input validation                                                                                               |
| `14-secret-management.md`   | Doppler, secret rotation, per-app config                                                                                            |
| `15-pdpl-compliance.md`     | Oman PDPL (always) + opt-in TRA/CDC/CBO/FSA/MOH privacy/regulatory overlays                                                         |
| `16-deployment.md`          | Render vs Vercel, Docker, CI/CD                                                                                                     |
| `19-ifrs-compliance.md`     | Financial statements, accounting records, ledgers, revenue recognition, leases, impairments, audit exports, or IFRS-scoped projects |
| `20-environments.md`        | Environment topology, Doppler/provider tiers, preview envs, and env drift enforcement                                               |
| `21-agent-orchestration.md` | Task lifecycle, GitHub Issues/Projects workflow, slash-command sequencing, and Claude/Codex handoff                                 |
| `22-kanban-console.md`      | Every product change in this T3 Code fork - architecture, GitHub Projects SSOT, GitOps, UI/i18n, and validation                     |

## Product Note

This repo intentionally uses the minimal governance profile plus `22-kanban-console.md`. Stack A/B rules are not active unless a future phase explicitly adopts that architecture.

## Philosophy

- "Earn your rules" — load only what the task needs
- Concise by default (~60–100 lines); deeper specs linked, not embedded
- Single source of truth: AGENTS.md → .ai/rules/ → task-specific context

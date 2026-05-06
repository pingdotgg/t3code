# kanban-console

Local desktop/web project console for managing GitHub Projects Kanban, monorepo git state, PR health, product artifacts, and agent workflows.

This repo is a fork of `pingdotgg/t3code`. The governance source is `MohAnghabo/ai-starter-pro`.

## Stack

This product intentionally starts from T3 Code rather than Stack A or Stack B. Preserve the upstream T3 Code split unless a planned phase explicitly changes it:

- `apps/server`: Node.js WebSocket server and provider/session runtime.
- `apps/web`: React/Vite UI.
- `apps/desktop`: Electron desktop shell where applicable.
- `packages/contracts`: Shared Effect Schema and TypeScript contracts; keep schema-only.
- `packages/shared`: Shared runtime utilities with explicit subpath exports.

All general `.ai/rules/` files still apply. Load `.ai/rules/22-kanban-console.md` for every product change. Stack-specific Stack A/Stack B rules apply only when a later change explicitly adopts one of those stacks.

## Commands

```bash
bun check              # format check + lint + typecheck + tests (required before every commit)
bun dev                # parallel dev servers
bun validate:local     # local validation plus desktop build
bun build              # full monorepo build via Turbo
bun pr:check           # PR readiness: local validation + docs/tests/CI checks
bun preflight          # stack-aware integration checks; writes .local/preflight/latest.{md,json}
rwx run tasks.yml --init commit-sha="$(git rev-parse HEAD)" --init repository-url="$(git remote get-url origin)" # run hosted CI locally in RWX Cloud
bun rwx:sync           # sync root tasks.yml to .rwx/ci.yml
bun rwx:check          # fail if tasks.yml and .rwx/ci.yml drift
bash scripts/adopt-template-rules.sh --target /absolute/path/to/repo --profile minimal   # apply governance kit to another repo
bash scripts/verify-template-adoption.sh --target /absolute/path/to/repo --profile minimal # verify adoption state in target repo
```

## Slash Commands

Claude command runbooks live in `.claude/commands/`. Codex-compatible wrappers
live in `.codex/commands/` and delegate to the same canonical runbooks. When a
user invokes `/command ...` in Codex, read `.codex/commands/command.md` first
and follow its canonical `.claude/commands/command.md` runbook. When a Claude
command changes, run `bun codex:sync`; `bun check` enforces `bun codex:check`
so the two command surfaces stay aligned.

| Command                               | Purpose                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `/init-project`                       | bootstrap a new repo from the template before non-trivial work                  |
| `/user-stories <feature-name> <goal>` | brainstorm feature stories as a local draft for standalone use or `/plan` input |
| `/plan <name> <goal>`                 | user stories → spec-driven plan in docs/tasks                                   |
| `/execute-task <issue-or-number>`     | branch → implement issue-only or legacy numbered work                           |
| `/plan-status [task-name\|--all]`     | compare current codebase progress against task plans in a table                 |
| `/phase <name> <phase-id>`            | implement one phase from a plan                                                 |
| `/orchestrate <task-name> [phase-id]` | choose and run the next safe command for a docs/tasks plan                      |
| `/preflight [flags]`                  | run stack-aware integration preflight                                           |
| `/env-audit [--fix] [--write]`        | run environment topology checks via preflight env/\*                            |
| `/review`                             | pre-PR review (bugs, regressions, coverage)                                     |
| `/open-pr <type> <short-description>` | branch → commit → push → PR → monitor CI and comments                           |
| `/ship <name>`                        | final pre-merge readiness pass                                                  |
| `/extract-pr-learnings <pr-number>`   | capture reusable lessons after a merged PR                                      |
| `/pdpl-audit`                         | scan for PDPL compliance gaps                                                   |
| `/ifrs-audit`                         | scan for IFRS Accounting Standards compliance gaps                              |
| `/security-audit [target]`            | run local-only deep security audit into `.local/security-audit/`                |
| `/upgrade-multitenant`                | Better Auth org upgrade guide                                                   |

## Preflight

- `bun preflight` is the stack-aware integration gate for Doppler, Better Auth,
  GitHub, stack providers, and environment topology.
- Reports are written to `.local/preflight/latest.md` and
  `.local/preflight/latest.json`; reference them in infrastructure PRs.
- `/env-audit` is an alias over `bun preflight --only=env/*`.
- CI exposes `preflight` and `env-audit` check runs; `pr-readiness` waits for
  `validate`, `preflight`, and `env-audit`.

## Task Orchestration

- GitHub Issues are the live work items; GitHub Projects is the live status board.
- `docs/tasks/*.md` remains the durable spec and execution-log source for
  non-trivial work.
- `tasks.md` is a legacy compatibility pointer, not the active queue.
- Use `/phase <task-name> <phase-id>` for modern `docs/tasks` plans.
- Use `/orchestrate <task-name>` when you need an agent to choose the next
  safe lifecycle command, stop at gates, and preserve issue/spec state.
- See `docs/agent-orchestration.md` and `.ai/rules/21-agent-orchestration.md`
  for the canonical lifecycle and command sequence.

## T3 Code Runtime Notes

T3 Code is a minimal web GUI for using coding agents like Codex and Claude. This fork is still early WIP, so sweeping changes are acceptable when they improve maintainability and reliability.

Core priorities:

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures, including session restarts, reconnects, and partial streams.

If a tradeoff is required, choose correctness and robustness over short-term convenience. Avoid duplicated logic; extract shared modules when behavior crosses package boundaries.

Codex app-server notes:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent`.

Reference repos:

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor: https://github.com/Dimillian/CodexMonitor

## CI

PR-readiness CI enforcement note:

- The readiness checker validates required GitHub check-runs via
  `PR_READINESS_REQUIRED_CHECKS` (default: `validate`)
- Derived repos should set this env var in `.github/workflows/pr-readiness.yml`
  to their actual required checks (comma-separated), for example:
  `PR_READINESS_REQUIRED_CHECKS: "validate,preflight,env-audit,security"`
- Do not include the `pr-readiness` job name itself in this list, or the check
  creates a circular dependency by waiting for itself.

## Project Bootstrap

Before the first non-trivial task in any repo created from this template:

1. Fill `docs/project.md`
2. Fill `review.md`
3. Fill `.cursor/BUGBOT.md`
4. Run `/init-project` if your agent supports slash commands

`/plan-status` can be run at the start of a conversation, and Claude Code may
also inject a compact plan snapshot automatically via the `SessionStart` hook.

If `docs/project.md` still contains template placeholders such as
`YOUR_PRODUCT_NAME`, `YOUR_APP_NAME`, unchecked stack selection, or generic
`[who are they?]` text, agents must stop non-trivial implementation and collect
bootstrap answers first.

If `review.md` or `.cursor/BUGBOT.md` still contains template placeholders
(for example `TEMPLATE_OR_PRODUCT`, `YOUR_TEAM_NAME`, `YOUR_PRIORITY_1`, or
`path/glob/**`), agents must stop non-trivial implementation and collect
bootstrap answers first.

Exception for template maintainers: product-agnostic template updates (for
example repository rules, workflow automation, scaffolding templates, and
agent guidance) may proceed before bootstrap files are initialized, provided
the change does not implement project-specific product behavior.

## Code Review (automatic)

After every Claude Code session, `.claude/hooks/coderabbit-review.sh` runs automatically and prints a CodeRabbit review to the terminal. It reviews against the PR base branch (if a PR is open) or the previous commit (HEAD~1). Project constraints from `CLAUDE.md` and relevant `.ai/rules/` files are injected automatically based on what changed.

**Required on each machine:**

```bash
npm install -g coderabbit   # install CLI
coderabbit auth             # authenticate (browser opens)
```

The hook skips silently if the CLI is not installed, so it won't break machines that haven't set it up yet.

## Closed-Loop PR Auto-Fix (optional)

- `.github/ai-loop.yml` is the source of truth for the optional PR review/fix loop
- Keep it disabled by default in template-derived repos until the bootstrap is complete
- Required secrets when enabling:
  - `AI_FIX_APP_ID`
  - `AI_FIX_APP_PRIVATE_KEY`
  - `CLAUDE_CODE_OAUTH_TOKEN` preferred, `ANTHROPIC_API_KEY` fallback
- Required bootstrap before enabling:
  - install the org-owned GitHub App on the repo
  - delete or scope legacy overlapping workflows before setting `enabled: true`
  - set `executor_bot_login` in `.github/ai-loop.yml`
  - configure `trusted_review_bots`
  - verify branch protection allows App pushes if same-branch auto-fix is desired

## Core Gotchas

1. **Contracts are SSOT** — keep shared protocol/schema changes in `packages/contracts`; do not bury cross-package contracts in app-only code.
2. **Better Auth v1.4 pinned** — do not upgrade to 1.5 (breaking: drizzle-adapter extracted, InferUser/InferSession removed, API Key plugin moved, $ERROR_CODES type changed).
3. **Better Auth local domains** — set `BETTER_AUTH_URL` to exact origin (e.g. `https://api.app.test`) and include it in `trustedOrigins`.
   Use `bash scripts/setup-domain.sh app --app-port 12000 --api-port 12001`;
   local domain ports must be explicit, unique per service, and `>=10000`.
4. **AR/EN always** — every user-facing string requires both Arabic and English translations.
5. **PDPL always** — Royal Decree 6/2022, fully enforced. No real PII in tests, logs, commits, or PR text.
6. **AWS Well-Architected always** — every non-trivial change and review must consider operational excellence, security, reliability, performance efficiency, cost optimization, and sustainability.
7. **Pre-merge gates always** — before merge, relevant Markdown docs must match the change, tests must be in the PR or explicitly marked no-impact, and all required CI must be green.
8. **Non-code outputs** — save to `.local/`, never project root or `docs/` unless permanent project documentation.
9. **IFRS when financial reporting** — if a task touches financial statements, ledgers, revenue recognition, leases, impairments, audit exports, or accounting records, load `.ai/rules/19-ifrs-compliance.md`. Use decimal-safe money handling, preserve audit trails, and never silently overwrite posted accounting records.

## AI Reading Order

1. `AGENTS.md` — commands, gotchas (this file)
2. `docs/project.md` — initialized product identity, stack choice, domain, i18n, regulatory and reporting scope
3. `review.md` — review scope, quality gates, and risk profile
4. `.cursor/BUGBOT.md` — Bugbot-specific review context and priorities
5. `.ai/rules/00-constitution.md` — non-negotiables
6. `.ai/rules/17-aws-well-architected.md` — mandatory architecture and review lens
7. `.ai/rules/18-pr-readiness.md` — mandatory PR readiness gates
8. `.ai/rules/21-agent-orchestration.md` — task lifecycle and command sequence
9. `.ai/rules/22-kanban-console.md` — product-specific rules for this T3 Code fork
10. T3 Code runtime notes in this file — package roles, Codex app-server flow, and upstream references
11. Relevant rule files for your task — include `.ai/rules/19-ifrs-compliance.md` for financial-reporting/accounting work; see `.ai/README.md` for the full map

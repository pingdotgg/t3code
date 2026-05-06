# 22 - Kanban Console Product Rules

Use this rule for every product change in this T3 Code fork.

## Product Boundary

- This repo is the product implementation for `MohAnghabo/kanban-console`.
- `MohAnghabo/ai-starter-pro` remains the governance source. Keep adopted rules
  and workflow guidance in sync when phase status or governance behavior changes.
- Do not implement Kanban Console product behavior in the governance template repo.
- Keep the local task plan at `docs/tasks/t3-kanban-project-console.md` aligned
  with GitHub issue #43 and the governance copy of the same plan.

## Architecture

- Preserve the upstream T3 Code package split unless a task phase explicitly
  changes it:
  - `apps/server`: server runtime, provider orchestration, local command adapters,
    polling, and audit logging.
  - `apps/web`: React/Vite UI, mock-first screens, i18n/RTL, and client state.
  - `apps/desktop`: desktop shell and local filesystem/secret access where needed.
  - `packages/contracts`: shared schemas and protocol contracts only.
  - `packages/shared`: reusable runtime utilities with explicit subpath exports.
- Prefer existing T3 Code patterns: Effect Schema/Effect services where already
  used, TanStack Query/router patterns in web, and existing source-control
  abstractions before adding parallel systems.
- Runtime boundaries must be typed and validated. Use the local package pattern:
  Effect Schema where T3 Code already uses it; Zod is acceptable for adopted
  governance scripts and isolated product boundaries when it is the simpler fit.

## Delivery Order

- Finish Phase 1 governance/GitOps/workflow setup before application features.
- Phase 2 must be a full clickable mock UI with no real GitHub, git, CLI, or
  provider mutations.
- Real integrations come after mock contracts are stable. Add deterministic
  synthetic fixtures before real provider tests.
- Keep PRs independently reviewable and close to the 400 LOC target. Split UI,
  contracts, adapters, and workflow automation into separate PRs when possible.

## GitHub Projects And Task State

- GitHub Projects is the live Kanban/task-status source of truth.
- Local `docs/tasks/*.md` files are durable specs and reference material only;
  they must not drive Kanban status inside the app.
- Kanban status changes must require confirmation before writing to GitHub
  Projects.
- Meaningful app actions linked to issues or PRs must post or update concise
  GitHub comments. Never include raw command output in comments.

## GitOps Rules

- Implementation branches must use one of:
  `feature/*`, `fix/*`, `chore/*`, `docs/*`, `ops/*`, `refactor/*`, `test/*`, or
  `perf/*`.
- Mutating work on `main` or `release/*` is blocked unless an explicit task rule
  allows a check-only or release-prep action.
- Release branches prepare artifacts and readiness evidence by default. Do not
  trigger deploys, tags, or merges without explicit confirmation and a later
  release policy decision.
- Destructive git actions require a second confirmation.

## Local Commands And Audit

- All local commands must run from a selected managed repository cwd, not an
  arbitrary shell cwd.
- CLI adapters need typed inputs, cwd pinning, timeouts, cancellation, redaction,
  and local audit records.
- Treat diffs, command output, CI logs, and review comments as sensitive until
  redacted.
- CodeRabbit, Doppler, Vercel, Render, and optional tools must degrade to
  setup-required states when missing or unauthenticated.

## UI And I18n

- The UI should be dense, operational, and work-focused. Avoid marketing-style
  layouts for the app surface.
- Every user-facing string needs English and Arabic translations.
- Verify RTL wherever Arabic renders.
- Build empty, loading, missing-auth, permission, error, and degraded states for
  each major workflow.

## Validation

- Minimum before committing product changes: `bun check`.
- For governance/adoption changes, also run:
  `bash scripts/verify-template-adoption.sh --profile minimal --manifest /Users/mohanghabo/Projects/ai-starter-pro/.template/adoption/minimal-files.txt`
  and `bun preflight --cache-only --json`.
- For UI changes, add or update focused tests and run browser/Playwright smoke
  once the screen is implemented.

---
task_name: t3-kanban-project-console
github_issue: 43
last_updated: 2026-05-06
---

# Task: t3-kanban-project-console

> Product-local copy: the canonical governance source is `MohAnghabo/ai-starter-pro`, but implementation work for this plan happens in this repo, `MohAnghabo/kanban-console`. Keep this file in sync with the governance plan when phase status changes.

> Frontmatter is managed by `/plan`. `github_issue` is set automatically on first publish; do not edit by hand unless you know the issue number.

## 1. Objective

Create a new product codebase by forking `pingdotgg/t3code` into a local
desktop/web project console for managing monorepo projects in one GitHub
organization.

The console must use GitHub Projects as the single source of truth for task
state, show each monorepo as a project by default, provide a Kanban workflow
for task status, expose a lazygit-style git status view, manage
`docs/product` Markdown artifacts, monitor PR comments and CI, suggest or run
safe fixes when applicable, and enforce the governance rules from this
template repo.

This template repo is the governance source for the new codebase. The product
implementation belongs in a new T3 Code fork, not inside this rules-only
template repo.

## 2. User Stories

- Story draft: inline in this GitHub-tracked plan. A `.local/user-stories/`
  draft is intentionally not used for this task because the user requested the
  user stories to be pushed to GitHub.
- Selected stories:
  - `US-001` - Monorepo project registry
  - `US-002` - GitHub Projects Kanban source of truth
  - `US-003` - Status transitions trigger agent workflow prompts
  - `US-004` - Lazygit-style repo status
  - `US-005` - `docs/product` artifacts
  - `US-006` - PR comments and CI watcher
  - `US-007` - GitHub issue and PR action timeline
  - `US-008` - GitOps branch and release enforcement
  - `US-009` - Claude and Codex workflow launchers

### `US-001` - Monorepo project registry

- Persona: maintainer.
- Priority: must.
- Dependencies: Phase 1 governance adoption.
- Story: As the maintainer, I want each monorepo shown as a project so I can
  manage all projects from one console.
- Acceptance criteria:
  - Given I register a repo path, when the remote belongs to the configured
    GitHub organization, then the repo appears as a project.
  - Given a repo path is missing or points outside the configured organization,
    when I try to register it, then the app rejects it with a clear setup
    message.
  - Given a project is selected, when I open the console, then Kanban, git,
    artifacts, PR watch, command console, and settings views are scoped to that
    repo by default.
- Data and privacy notes: store local repo paths and GitHub owner/name only;
  no secrets or PII are required.
- Localization notes: all registry, setup, and error strings need AR/EN and RTL
  coverage.
- Open questions: final fork repo name and GitHub organization are not recorded.

### `US-002` - GitHub Projects Kanban source of truth

- Persona: maintainer.
- Priority: must.
- Dependencies: `US-001`; GitHub Project field names confirmed.
- Story: As the maintainer, I want GitHub Projects Kanban to be task SSOT so
  status is never split across local files and GitHub.
- Acceptance criteria:
  - Given `gh auth` is valid, when I open the Kanban board, then tasks load
    from the configured GitHub Project.
  - Given a GitHub Project item has a linked repo issue, when it renders, then
    the card shows issue number, title, repo, status, priority, type, stack,
    compliance, linked PRs, and linked spec path when present.
  - Given a local `docs/tasks/*.md` file exists, when it is linked from a card,
    then it is displayed as reference material only and does not drive Kanban
    status.
- Data and privacy notes: GitHub issue and project metadata may contain user
  text; logs and fixtures must use synthetic examples only.
- Localization notes: board labels, field labels, empty states, and permission
  errors need AR/EN and RTL coverage.
- Open questions: exact Project field names and option values remain open.

### `US-003` - Status transitions trigger agent workflow prompts

- Persona: maintainer.
- Priority: must.
- Dependencies: `US-002`; agent workflow contracts.
- Story: As the maintainer, I want card moves to trigger suggested agent
  workflows so status transitions lead to concrete action.
- Acceptance criteria:
  - Given I drag a card to a new column, when the drop completes, then the app
    opens an action sheet before any agent or command work starts.
  - Given I confirm the action, when the transition is valid, then the GitHub
    Project status updates and the selected Claude or Codex workflow receives
    the task context package.
  - Given I repeat the same drag/drop, when an agent run is already queued or
    running for that transition, then the app does not start a duplicate run.
- Data and privacy notes: prompt context must exclude secrets and redact command
  output before any GitHub comment or local audit record.
- Localization notes: transition labels, warnings, and confirmation copy need
  AR/EN and RTL coverage.
- Open questions: which transitions may auto-run without confirmation remains
  open.

### `US-004` - Lazygit-style repo status

- Persona: maintainer.
- Priority: must.
- Dependencies: `US-001`; local repo clone available.
- Story: As the maintainer, I want lazygit-style status so I can inspect repo
  changes from the app.
- Acceptance criteria:
  - Given a repo is selected, when I open git status, then I see branch,
    upstream, staged files, unstaged files, untracked files, and diffs.
  - Given I stage or unstage a file, when I confirm the action, then the git
    index updates and the UI refreshes.
  - Given I attempt a destructive action, when the app presents the action,
    then a second confirmation is required.
- Data and privacy notes: diffs can contain secrets or PII; output must be
  redacted before comments, screenshots, fixtures, or audit exports.
- Localization notes: git status labels and confirmation copy need AR/EN and RTL
  coverage.
- Open questions: hunk-level staging feasibility remains implementation-dependent.

### `US-005` - `docs/product` artifacts

- Persona: maintainer.
- Priority: must.
- Dependencies: `US-001`; git status and guarded patch flow.
- Story: As the maintainer, I want `docs/product` artifacts so product docs stay
  close to code.
- Acceptance criteria:
  - Given a selected repo has `docs/product`, when I open artifacts, then I can
    browse Markdown files under that root.
  - Given I select an artifact, when I open it, then I can preview and edit
    Markdown.
  - Given I save an edit, when the target file is clean, then the app writes
    through a guarded branch/patch flow and comments on the linked task or PR.
  - Given the file is dirty or conflicting, when I save, then the app blocks the
    write and explains the conflict.
- Data and privacy notes: product docs may contain sensitive planning details;
  fixtures must use synthetic content and comments must summarize only.
- Localization notes: artifact navigation, editor states, and conflict messages
  need AR/EN and RTL coverage.
- Open questions: whether the app should create `docs/product` when missing is
  not yet decided.

### `US-006` - PR comments and CI watcher

- Persona: maintainer.
- Priority: must.
- Dependencies: `US-002`; `gh auth`; linked PRs.
- Story: As the maintainer, I want PR comments and CI watched after PR open so
  failures are surfaced quickly.
- Acceptance criteria:
  - Given a task has linked PRs, when the watcher runs, then it polls PR
    comments, review comments, review summaries, check runs, and workflow runs.
  - Given CI fails, when the failed signal is new, then the app records it,
    updates the UI, and suggests a fix prompt.
  - Given CI recovers, when the watcher observes success, then the app updates
    the task and PR timeline.
  - Given polling sees the same signal repeatedly, when the fingerprint matches,
    then duplicate suggestions are suppressed.
- Data and privacy notes: CI logs and review comments may contain sensitive
  information; use summaries and redacted local audit records.
- Localization notes: watcher states, failure categories, and setup errors need
  AR/EN and RTL coverage.
- Open questions: default polling interval remains open.

### `US-007` - GitHub issue and PR action timeline

- Persona: maintainer.
- Priority: must.
- Dependencies: `US-002`; GitHub write access.
- Story: As the maintainer, I want every issue and PR action commented so each
  work item has a clear activity trail.
- Acceptance criteria:
  - Given a meaningful app action starts, when it is linked to an issue or PR,
    then the app posts or updates a concise GitHub comment.
  - Given an action completes, fails, or blocks, when the state changes, then
    the linked issue or PR records the outcome and next step.
  - Given command output exists, when the app posts a GitHub comment, then it
    includes only a summary and never raw logs.
- Data and privacy notes: full metadata stays in local redacted audit storage;
  GitHub comments must not include secrets, PII, raw logs, or credential
  fragments.
- Localization notes: comment templates are internal developer-facing text; keep
  app UI around comment actions AR/EN-ready.
- Open questions: new comment per action versus sticky comments for noisy events
  remains open.

### `US-008` - GitOps branch and release enforcement

- Persona: maintainer.
- Priority: must.
- Dependencies: `US-004`; branch policy configuration.
- Story: As the maintainer, I want GitOps branch and release rules enforced so
  agent work follows a predictable delivery path.
- Acceptance criteria:
  - Given a branch is named `feature/*`, `fix/*`, `chore/*`, `docs/*`,
    `ops/*`, `refactor/*`, `test/*`, or `perf/*`, when work starts, then the
    app treats it as implementation work requiring a PR.
  - Given the current branch is `main` or `release/*`, when a mutating fix is
    requested, then the app blocks or switches to check-only mode unless an
    approved policy allows it.
  - Given a release is prepared, when release readiness is opened, then the app
    shows required checks, release notes, tag readiness, and provider status.
- Data and privacy notes: release comments and notes must avoid secrets, PII,
  and raw command logs.
- Localization notes: GitOps warnings, gate names, and release readiness labels
  need AR/EN and RTL coverage.
- Open questions: whether release branches trigger deployment or only prepare
  artifacts remains open.

### `US-009` - Claude and Codex workflow launchers

- Persona: maintainer.
- Priority: must.
- Dependencies: `US-003`; adopted agent orchestration rules.
- Story: As the maintainer, I want Claude and Codex workflows available from
  the UI so the best agent path can be selected per task.
- Acceptance criteria:
  - Given Claude Code is available, when I choose a Claude workflow, then the
    app launches the matching `.claude/commands` workflow with task context.
  - Given Codex is available, when I choose a Codex workflow, then the app
    launches an equivalent recipe using the same governance and task context.
  - Given neither agent path is available, when I open the action sheet, then
    the app shows setup-required states and does not lose the task transition.
- Data and privacy notes: agent prompts must exclude secrets and use redacted
  summaries for command output and comments.
- Localization notes: launcher UI and unavailable-state messages need AR/EN and
  RTL coverage.
- Open questions: exact local Codex and Claude invocation APIs need verification
  in the new fork environment.

## 3. Scope

- In scope:
  - Fork `pingdotgg/t3code` into a new product repo.
  - Adopt this template repo's governance kit into that fork.
  - Build the full clickable UI first with mock data only.
  - Use one GitHub organization as the default workspace boundary.
  - Treat each monorepo as one project by default.
  - Use GitHub Projects as Kanban and task status source of truth.
  - Treat `docs/tasks/*.md` as linked reference material only.
  - Add GitOps branch, PR, release, and tag readiness rules.
  - Add GitHub issue and PR action comments for meaningful app actions.
  - Add PR polling for comments, review signals, and CI/check-run changes.
  - Add suggested-fix and gated auto-fix workflows.
  - Add Claude workflow launchers based on `.claude/commands`.
  - Add Codex-equivalent workflow recipes using the same governance rules.
  - Add safe CLI adapters for `gh`, `git`, `coderabbit`, `doppler`,
    `vercel`, `render`, `bun`, and constrained `bash`.
  - Add `docs/product` artifact browse, preview, and edit workflows.
- Out of scope:
  - Building the app inside this template repo.
  - Hosted SaaS mode.
  - Webhook-first PR subscriptions.
  - Full lazygit parity.
  - Automatic PR merge.
  - Unrestricted terminal access.
  - Multi-organization support.
  - Product-specific business behavior beyond the project console.

## 4. Requirements

- Functional:
  - The first implementation milestone must produce the full product UI with mock data only.
  - GitHub Projects must own all task state.
  - Kanban status changes must write to GitHub Projects only after confirmation.
  - Moving a Kanban card must open a prompt/action sheet before agent work starts.
  - Each meaningful app action must post or update a concise GitHub issue or PR comment.
  - The app must maintain a fuller local redacted audit log for command and agent runs.
  - PR watcher v1 must poll through `gh`, not webhooks.
  - Failed CI and trusted review signals must generate suggested fixes.
  - Auto-fix must be gated by trusted source, attempt budget, finding fingerprint, validation, and branch policy.
  - Git status must show branch, upstream, staged files, unstaged files, untracked files, and diffs.
  - Artifact workflows must be confined to `docs/product/**/*.md`.
  - Artifact edits must use guarded branch/patch flow.
  - CLI tools must run through typed adapters with redaction, timeouts, cwd pinning, and audit logging.
  - Claude and Codex workflow launchers must package the same task context: issue URL, project fields, repo path, branch, PR URL, artifacts, git state, validation commands, and governance rules.
- Non-functional:
  - UI must be operational, dense, and work-focused rather than a marketing surface.
  - Every user-facing string must have AR and EN translations.
  - RTL layout must be verified wherever Arabic renders.
  - No real PII, secrets, tokens, raw credential fragments, or unredacted command logs may appear in tests, logs, screenshots, fixtures, issue comments, PR text, or audit exports.
  - Real integrations must be testable with deterministic synthetic fixtures.
  - The app must degrade clearly when required CLIs or auth are unavailable.

## 5. Constraints

- Technical constraints:
  - New codebase starts from a T3 Code fork.
  - Preserve T3 Code's app split: `apps/server`, `apps/web`, shared contracts, and shared runtime packages unless upstream changes require an equivalent structure.
  - Use TypeScript strict mode.
  - No `any`; use `unknown` plus type guards.
  - Use Zod for runtime validation.
  - Use T3 Code's existing frontend stack where available: React, Vite, TanStack Router/Query, Zustand, `@dnd-kit`, and lucide.
  - Local command execution must run from a selected managed repo cwd.
  - Mutating commands require explicit confirmation.
  - Destructive commands require second confirmation.
  - GitHub comments must never include full raw command logs.
- Dependency constraints:
  - Local clones must exist before git, artifact, or agent workflows run.
  - `gh auth` is required before real GitHub reads or writes.
  - CodeRabbit, Doppler, Vercel, Render, and Bun integrations degrade to setup-required states when CLIs are missing.
  - Closed-loop PR auto-fix credentials remain blocked by issue #40 in this template repo; the Kanban app must model this as a later integration dependency, not a UI-first blocker.
- Delivery constraints:
  - Full mock UI lands before real integrations.
  - Governance adoption lands before product implementation.
  - Each implementation phase must be independently reviewable and validated.
  - PRs should remain within the 400 LOC budget unless a documented exception is unavoidable.

## 6. Well-Architected Impact

- Operational excellence:
  - Centralizes task state, repo status, PR health, product artifacts, command runs, and agent workflows.
  - GitHub comments create an auditable action timeline on issues and PRs.
  - UI-first delivery reduces product and workflow ambiguity before integrating external systems.
- Security:
  - Local-first v1 avoids hosted token storage.
  - CLI adapters redact output before UI display, comments, and audit logs.
  - Auto-fix is gated by trusted source, branch policy, and attempt budget.
  - Doppler remains the expected secret manager for projects that need secrets.
- Reliability:
  - GitHub Projects provides one live task source.
  - PR polling avoids webhook and tunnel setup fragility in v1.
  - Debounce, fingerprints, and attempt budgets prevent repeated fix loops.
  - Mock-first contracts reduce integration surprises.
- Performance efficiency:
  - GitHub polling must be scoped to selected projects and open PRs.
  - Large Kanban boards and git diffs need virtualization or lazy loading.
  - CLI commands must have timeouts and cancellation behavior.
- Cost optimization:
  - Reuses GitHub and local CLIs instead of adding hosted infrastructure in v1.
  - Safe auto-fix can reduce repeated failed CI cycles.
  - UI-first milestone avoids wasting integration time on unreviewed workflows.
- Sustainability:
  - GitHub Projects avoids duplicate task state.
  - `docs/product` keeps product artifacts durable and repo-local.
  - Governance kit adoption prevents workflow drift between this template and the new product.

## 7. Gaps and Questions

- [x] New T3 Code fork repo name and location are recorded: `MohAnghabo/kanban-console`, `/Users/mohanghabo/Projects/kanban-console`, default branch `main`.
- [ ] Exact GitHub Project field names and option values need confirmation.
- [ ] Default PR polling interval needs confirmation.
- [ ] Trusted bots beyond `coderabbitai[bot]`, if any, need confirmation.
- [ ] Action comment policy needs a final decision: new comment per event versus sticky comment updates for noisy events.
- [ ] Auto-fix categories that can run without per-run confirmation need confirmation.
- [ ] Release policy needs confirmation: release branches prepare artifacts only, or also trigger deployments.
- [ ] Hunk-level staging feasibility depends on selected git implementation details in the fork.

## 8. Assumptions

- Most managed projects are monorepos.
- All managed repos live under one GitHub organization.
- GitHub Projects contains the live task queue and task status.
- `docs/tasks/*.md` can be linked from tasks but does not drive Kanban state.
- `docs/product` exists or can be created in each managed repo.
- Local polling every 30 to 90 seconds is acceptable for PR comments and CI state.
- Final PR merge remains outside app automation in v1.
- The new product repo can adopt this template's governance files and rules.

## 9. Risks

- Risk:
  - Auto-fix loops could create repeated commits or noisy PR timelines.
  - Impact:
    - Wasted CI, confusing PR history, and possible unsafe changes.
  - Mitigation:
    - Use trusted-source checks, attempt budgets, debounce windows, branch policy, finding fingerprints, validation gates, pause labels, and explicit audit records.

- Risk:
  - General bash support could leak secrets or run destructive commands.
  - Impact:
    - Data exposure or local repo damage.
  - Mitigation:
    - Use allowlisted command recipes, confirmation gates, cwd pinning, redaction, timeout, and local audit logging. Deny destructive patterns unless a project admin policy enables them.

- Risk:
  - GitHub Projects as task SSOT can conflict with older `docs/tasks` guidance in derived repos.
  - Impact:
    - Agent workflows may read stale local task state.
  - Mitigation:
    - Adopt the current agent orchestration rule and GitHub Projects workflow from this template. Keep `docs/tasks` reference-only in the app.

- Risk:
  - Full mock UI can diverge from real `gh` and provider API constraints.
  - Impact:
    - Rework after integration starts.
  - Mitigation:
    - Shape mock contracts around known GitHub, git, CLI adapter, and T3 Code boundaries. Validate read-only `gh` feasibility before mutating integrations.

- Risk:
  - Copying governance into the fork can drift from this template over time.
  - Impact:
    - The product console may enforce obsolete rules.
  - Mitigation:
    - Use adoption scripts where possible, document update cadence, and add checks that identify governance drift.

## 10. Phased Plan

### Phase 1: New Fork And Governance Adoption

- Goal:
  - Create the new product codebase from T3 Code and enforce this template's rules before product implementation.
- Dependencies: none.
- Tasks:
  - [x] Create or fork the new T3 Code repo.
  - [x] Record the fork URL and default branch.
  - [x] Adopt `AGENTS.md`, `.ai/rules`, PR readiness, review guidance, PDPL, i18n, secret-management, Well-Architected, GitHub Projects workflow, and agent orchestration rules.
  - [x] Add project-specific GitOps rules for feature, fix, chore, docs, ops, main, release, and tag flows.
  - [x] Add Claude workflow templates from `.claude/commands`.
  - [x] Add Codex-equivalent workflow recipes.
  - [x] Configure the fork's validation command.
- Validation:
  - Governance files exist in the fork.
  - Validation command is documented and passes for the initial fork state.
  - No application feature code is added before governance adoption.
- Exit criteria:
  - Future work in the fork is governed by this template's rules.

### Phase 2: Full Mock UI

- Goal:
  - Build the complete clickable product UI with mock data and no real integrations.
- Dependencies: Phase 1.
- Tasks:
  - [ ] Project sidebar for registered monorepos.
  - [ ] GitHub Projects Kanban mock board.
  - [ ] Task detail panel with issue metadata, project fields, PR links, comments, checks, and agent actions.
  - [ ] Card-move action sheet.
  - [ ] Lazygit-style git status mock view.
  - [ ] `docs/product` artifact browser, preview, and editor mock flow.
  - [ ] PR watcher mock view for comments, checks, suggestions, and auto-fix eligibility.
  - [ ] Issue and PR action timeline.
  - [ ] CLI command console.
  - [ ] GitOps and release dashboard.
  - [ ] Settings for organization, repos, trusted bots, branch rules, polling, and command permissions.
  - [ ] Empty, loading, permission, missing-auth, and error states for each view.
  - [ ] AR/EN translation keys and RTL checks for user-facing UI.
- Validation:
  - Playwright smoke flow across every major screen.
  - Desktop and mobile screenshots for review.
  - No real API, git, or CLI mutations.
- Exit criteria:
  - The full workflow can be reviewed visually before integration work begins.

### Phase 3: Contracts And Mock Runtime

- Goal:
  - Stabilize typed contracts behind the UI so real integrations can replace mocks incrementally.
- Dependencies: Phase 2.
- Tasks:
  - [ ] Define contracts for managed repos, project boards, Kanban tasks, task transitions, PR watches, check runs, review signals, suggested fixes, command runs, git status, artifacts, GitOps policy, release readiness, and agent workflows.
  - [ ] Add Zod schemas for runtime boundaries.
  - [ ] Add mock providers behind real API-shaped interfaces.
  - [ ] Add transition tests for Kanban, PR watch, and auto-fix eligibility.
- Validation:
  - Typecheck passes.
  - Unit tests cover transition and classification rules.
  - Mock runtime drives UI without special cases.
- Exit criteria:
  - Real integrations can be added provider by provider.

### Phase 4: GitHub Projects Read And Write

- Goal:
  - Connect Kanban to GitHub Projects through `gh`.
- Dependencies: Phase 3.
- Tasks:
  - [ ] Add `gh auth` readiness check.
  - [ ] Read organization Projects.
  - [ ] Read selected Project fields and options.
  - [ ] Read project items, linked issues, linked PRs, and repo names.
  - [ ] Map GitHub Project items into Kanban tasks.
  - [ ] Update GitHub Project status after confirmation.
  - [ ] Post issue comments for status moves.
- Validation:
  - Synthetic `gh` fixture tests.
  - Manual read-only smoke against a test Project.
  - Manual status update smoke against a non-production test item.
- Exit criteria:
  - GitHub Projects is live Kanban task state.

### Phase 5: Agent Workflow Launchers

- Goal:
  - Launch Claude and Codex workflows from task actions.
- Dependencies: Phase 4.
- Tasks:
  - [ ] Add Claude command launcher for `/init-project`, `/user-stories`, `/plan`, `/phase`, `/execute-task`, `/review`, `/open-pr`, `/ship`, `/extract-pr-learnings`, `/pdpl-audit`, `/ifrs-audit`, and `/orchestrate` where available.
  - [ ] Add Codex-equivalent workflow recipes.
  - [ ] Build shared task context package.
  - [ ] Show agent session status on cards.
  - [ ] Post GitHub comments for session started, completed, failed, and blocked states.
  - [ ] Prevent duplicate agent runs for repeated drag/drop actions.
- Validation:
  - Mock agent session tests.
  - Manual local session smoke where available.
- Exit criteria:
  - Card transitions can trigger confirmed agent workflows.

### Phase 6: Git Status And GitOps Enforcement

- Goal:
  - Add real git status and enforce branch policy.
- Dependencies: Phase 3.
- Tasks:
  - [ ] Read branch and upstream state.
  - [ ] Read staged, unstaged, and untracked files.
  - [ ] Render file diffs.
  - [ ] Support safe stage and unstage file actions.
  - [ ] Evaluate hunk-level staging feasibility.
  - [ ] Enforce branch naming policy.
  - [ ] Detect protected branch violations.
  - [ ] Show release readiness and tag readiness.
- Validation:
  - Temporary git repo tests.
  - Playwright flow for clean, dirty, staged, unstaged, and untracked states.
- Exit criteria:
  - The app can inspect repo state and enforce GitOps rules.

### Phase 7: Product Artifacts

- Goal:
  - Manage Markdown artifacts under `docs/product`.
- Dependencies: Phase 6.
- Tasks:
  - [ ] Browse `docs/product`.
  - [ ] Preview Markdown.
  - [ ] Edit Markdown.
  - [ ] Write through guarded branch/patch flow.
  - [ ] Block edits on conflicting dirty files.
  - [ ] Link artifact edits to a GitHub task or PR where applicable.
  - [ ] Post concise GitHub comments for artifact edit actions.
- Validation:
  - Path confinement tests.
  - Dirty-file conflict tests.
  - Playwright edit, preview, patch flow.
- Exit criteria:
  - Product docs can be safely viewed and edited.

### Phase 8: PR Watcher And Suggested Fixes

- Goal:
  - Poll PR comments and CI state, then generate suggested fixes.
- Dependencies: Phase 4.
- Tasks:
  - [ ] Poll check runs and workflow runs.
  - [ ] Poll PR review comments.
  - [ ] Poll review summaries.
  - [ ] Poll issue comments on linked PRs and tasks.
  - [ ] Detect new signals and suppress duplicates.
  - [ ] Classify failed checks and trusted review comments.
  - [ ] Generate suggested fix prompts.
  - [ ] Post or update action comments for material PR state changes.
- Validation:
  - Synthetic fixture tests for CI failure, CI recovery, review comments, duplicate suppression, and stale polling data.
- Exit criteria:
  - PR health and suggested next actions appear in the app and GitHub timeline.

### Phase 9: Gated Auto-Fix

- Goal:
  - Safely run fix workflows for trusted failures.
- Dependencies: Phase 8.
- Tasks:
  - [ ] Add trusted source configuration.
  - [ ] Add attempt budgets.
  - [ ] Add finding fingerprints.
  - [ ] Add pause label handling.
  - [ ] Add branch-policy gates.
  - [ ] Launch agent fix sessions.
  - [ ] Run configured validation before push.
  - [ ] Post comments for auto-fix queued, running, pushed, blocked, exhausted, and clean states.
  - [ ] Treat missing ai-loop credentials from issue #40 as a setup-required state.
- Validation:
  - Loop prevention tests.
  - Budget exhaustion tests.
  - Trusted/untrusted source tests.
  - Branch policy tests.
- Exit criteria:
  - Controlled auto-fix works without noisy loops.

### Phase 10: CLI Adapter Layer

- Goal:
  - Integrate external CLI tools safely.
- Dependencies: Phase 3.
- Tasks:
  - [ ] Define adapter contract.
  - [ ] Implement `gh` adapter.
  - [ ] Implement `git` adapter.
  - [ ] Implement `coderabbit` adapter.
  - [ ] Implement `doppler` adapter.
  - [ ] Implement `vercel` adapter.
  - [ ] Implement `render` adapter.
  - [ ] Implement `bun` adapter.
  - [ ] Implement constrained `bash` adapter.
  - [ ] Add redaction and local audit logging to every adapter.
- Validation:
  - Missing CLI tests.
  - Timeout tests.
  - Redaction tests.
  - Mutation confirmation tests.
- Exit criteria:
  - Known tools are available safely from the UI.

### Phase 11: Release Workflow

- Goal:
  - Add release branch and tag readiness workflow.
- Dependencies: Phases 6, 8, and 10.
- Tasks:
  - [ ] Evaluate release branch policy.
  - [ ] Draft release notes from issues, PRs, and artifacts.
  - [ ] Show required checks and review state.
  - [ ] Show deployment provider readiness.
  - [ ] Check tag readiness.
  - [ ] Post GitHub comments for release preparation actions.
  - [ ] Keep actual merge/deploy/tag execution confirmation-gated.
- Validation:
  - Mock release flow.
  - Fixture tests for eligible and blocked release states.
- Exit criteria:
  - The app can guide release preparation without unsafe merge or deploy automation.

### Phase 12: Hardening And Daily-Use Readiness

- Goal:
  - Prepare the project console for controlled use on real repos.
- Dependencies: Phases 1-11.
- Tasks:
  - [ ] Performance pass for large boards and monorepos.
  - [ ] Reconnect and restart behavior.
  - [ ] Keyboard navigation.
  - [ ] Accessibility checks.
  - [ ] Documentation for setup and workflows.
  - [ ] End-to-end smoke suite.
  - [ ] Governance drift check against this template.
- Validation:
  - Full validation command passes.
  - Playwright smoke passes.
  - Documentation, tests, and CI readiness are complete.
- Exit criteria:
  - App is ready for controlled daily use on real repos.

## 11. Acceptance Criteria

- [ ] New T3 Code fork exists as the product codebase.
- [ ] This template repo's governance rules are adopted into the fork.
- [ ] GitOps branch and release rules are documented and enforced.
- [ ] Full clickable UI exists before real integrations.
- [ ] GitHub Projects is task SSOT.
- [ ] Each monorepo is represented as a project by default.
- [ ] `docs/tasks/*.md` is reference-only in the app.
- [ ] Every meaningful issue or PR action creates a clear GitHub comment or sticky comment update.
- [ ] PR watcher detects comments and CI changes.
- [ ] Suggested fixes are generated for failed checks and trusted reviews.
- [ ] Auto-fix is gated and loop-safe.
- [ ] Claude command workflows are available.
- [ ] Codex equivalent workflows are available.
- [ ] CLI adapters are typed, redacted, timed out, audited, and confirmation-gated.
- [ ] Git status view supports branch, files, diffs, and staging.
- [ ] `docs/product` artifacts can be browsed, previewed, and edited.
- [ ] AR/EN and RTL readiness exist for all user-facing UI.
- [ ] No real PII or secrets appear in logs, comments, fixtures, screenshots, or PR text.
- [ ] Phase 10 of `i-want-to-continue-frolicking-pnueli` remains non-blocking for this plan.

## 12. Execution Log

Append one entry per implementation pass.

### 2026-05-05 00:00 - planning

- Summary:
  - Captured the Kanban/T3 Code project-console plan in the workspace.
- Files changed:
  - `docs/tasks/t3-kanban-project-console.md`
- Validation run:
  - Command: `bun run plan:lint docs/tasks/t3-kanban-project-console.md`
  - Result: PASS
  - Command: `bun run scripts/plan-status.ts t3-kanban-project-console`
  - Result: PASS
  - Command: `git diff --check`
  - Result: PASS
  - Command: `bun check`
  - Result: PASS
- Notes/deviations:
  - This plan is saved in the template repo for governance tracking. Product implementation must happen in a new T3 Code fork.

### 2026-05-06 00:00 - story-publish

- Summary:
  - Expanded the selected user stories inline in this GitHub-tracked plan so
    the stories are pushed with the plan instead of living only under
    `.local/user-stories/`.
- Files changed:
  - `docs/tasks/t3-kanban-project-console.md`
- Validation run:
  - Command: `bun run plan:lint docs/tasks/t3-kanban-project-console.md`
  - Result: PASS
  - Command: `bun run scripts/plan-status.ts t3-kanban-project-console`
  - Result: PASS
  - Command: `git diff --check`
  - Result: PASS
  - Command: `bun check`
  - Result: PASS
- Notes/deviations:
  - `.claude/commands/user-stories.md` intentionally treats standalone story
    drafts as local-only. For this task, the durable GitHub-visible record is
    Section 2 of this plan.

### 2026-05-06 13:55 - phase 1 bootstrap start

- Summary:
  - Found existing GitHub issue #43 for this plan.
  - Forked `pingdotgg/t3code` to `MohAnghabo/kanban-console`.
  - Cloned the fork to `/Users/mohanghabo/Projects/kanban-console`.
  - Applied the minimal governance kit into the fork and merged upstream T3 Code agent guidance into the adopted `AGENTS.md`.
- Files changed:
  - `docs/tasks/t3-kanban-project-console.md`
  - Product repo: `/Users/mohanghabo/Projects/kanban-console`
- Validation run:
  - Command: `gh issue list --repo MohAnghabo/ai-starter-pro --state open --limit 100 --json number,title,labels,url,createdAt,updatedAt`
  - Result: PASS
  - Command: `gh issue view 43 --repo MohAnghabo/ai-starter-pro --json number,title,body,labels,url,state`
  - Result: PASS
  - Command: `gh api repos/pingdotgg/t3code/forks -X POST -f owner=MohAnghabo -f name=t3-kanban-console`
  - Result: PASS
  - Command: `gh api repos/MohAnghabo/t3-kanban-console -X PATCH -f name=kanban-console`
  - Result: PASS
  - Command: `git clone https://github.com/MohAnghabo/kanban-console.git /Users/mohanghabo/Projects/kanban-console`
  - Result: PASS
  - Command: `bash scripts/adopt-template-rules.sh --target /Users/mohanghabo/Projects/kanban-console --profile minimal`
  - Result: PASS
- Notes/deviations:
  - The fork name is `kanban-console`, per user direction.
  - The adoption step initially produced an accidental newline-named `AGENTS.md` artifact because the upstream repo uses a `CLAUDE.md -> AGENTS.md` symlink and the template also ships Claude guidance. The useful T3 Code guidance was recovered from git and merged into the real `AGENTS.md`; the accidental artifact was removed.
  - `CLAUDE.md` was repaired as a clean symlink to `AGENTS.md`.
  - T3 Code's `scripts` workspace typecheck and Vitest discovery needed local configuration so adopted governance runtime scripts do not get compiled or discovered as upstream package tests.
  - Validation command configured as `bun check`.
  - Command: `bash scripts/verify-template-adoption.sh --profile minimal --manifest /Users/mohanghabo/Projects/ai-starter-pro/.template/adoption/minimal-files.txt`
  - Result: PASS
  - Command: `bun preflight --cache-only --json`
  - Result: PASS
  - Command: `bun run check`
  - Result: PASS

### 2026-05-06 14:25 - product rules layer

- Summary:
  - Added product-local rule discovery via `.ai/README.md`.
  - Added `.ai/rules/22-kanban-console.md` with Kanban Console product boundaries, T3 Code architecture guidance, delivery order, GitHub Projects SSOT, GitOps branch/release rules, local command/audit rules, UI/i18n rules, and validation expectations.
  - Updated `AGENTS.md` reading order to load the product-specific rule for every product change.
- Files changed:
  - `.ai/README.md`
  - `.ai/rules/22-kanban-console.md`
  - `AGENTS.md`
  - `docs/tasks/t3-kanban-project-console.md`
- Validation run:
  - Command: `bun run fmt:check`
  - Result: PASS
- Notes/deviations:
  - Stack A/B rules remain intentionally inactive unless a future phase explicitly adopts that architecture.

### 2026-05-06 14:45 - phase 1 workflow templates

- Summary:
  - Added the full Claude command template set from the governance source.
  - Added generated Codex command wrappers that delegate to the canonical Claude runbooks.
  - Added Codex command/environment sync scripts and package scripts so `bun check` verifies the Codex surface stays aligned.
- Files changed:
  - `.claude/commands/*.md`
  - `.codex/commands/*.md`
  - `.codex/environments/environment.toml`
  - `scripts/sync-codex-commands.ts`
  - `scripts/sync-codex-environment.ts`
  - `package.json`
  - `docs/tasks/t3-kanban-project-console.md`
- Validation run:
  - Command: `bun codex:sync`
  - Result: PASS
- Notes/deviations:
  - The Codex command files are generated wrappers; update `.claude/commands/*.md` first, then run `bun codex:sync`.

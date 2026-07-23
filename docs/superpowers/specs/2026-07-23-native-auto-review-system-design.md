# Native Auto-Review System Design

**Issue:** [SER-141](https://linear.app/sergedev/issue/SER-141/need-native-auto-review-system)  
**Date:** 2026-07-23  
**Status:** Approved design (pending implementation plan)

## Context

SurgeCode already has **read-only** pull-request review surfaces:

- Server `ReviewService` fetches PR comments, reviews, and review threads.
- GitHub (and other SCMs) list/create change requests via CLI wrappers.
- macOS exposes PR review UI and a **“Fix Reviews”** follow-up that prompts the
  agent to address external bot comments (CodeRabbit-style), driven by
  `reviewLifecycle` / actionable thread counts.

What is missing is a **native auto-reviewer**: watch projects added to
SurgeCode, review eligible open PRs with a user-selected model from configured
providers, post a real GitHub review, and optionally auto-prompt the origin
thread that created the PR to fix high-signal findings.

This design specifies a **structured, server-owned pipeline** (not an
agent-tool free-for-all) so posting and idempotency stay deterministic on a
local server without public webhooks.

## Goals

- Detect new and updated open PRs on repos for projects in SurgeCode.
- Honor user preferences: off, automatic on open/push, or mention-gated
  (`@surgecode` by default).
- Run review with a selected provider model.
- Post a real GitHub pull-request review (summary + inline comments when
  anchorable).
- When a SurgeCode origin thread can be linked and findings are
  blocking/important, auto-prompt that thread to fix them.
- Default **off** until the user opts in; safe under multi-project load and
  server restarts.
- Stay within existing local-server constraints (no public webhook endpoint
  required for v1).

## Non-goals (v1)

- GitHub webhooks or cloud/relay ingress.
- Auto-review for GitLab, Bitbucket, or Azure DevOps.
- Agent-tool-driven review posting (`gh` called by a free-form agent turn).
- Creating a new fix thread when no origin thread exists.
- Formal GitHub App / dedicated bot identity (posts as the authenticated `gh`
  user).
- Full iPhone settings UI (server config works; mobile UI is follow-up).
- Becoming a general CI gate or required status check.

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Structured server pipeline (Approach B) | Deterministic post path, idempotency, cost control; reuses text-generation patterns |
| Discovery | Local poll via `gh` CLI/API | Local server usually has no public URL; matches existing GitHub integration |
| Eligible PRs | All open PRs on project repos (incl. drafts) | External and agent-created PRs both matter |
| Re-run policy | On open + each new head SHA | Keep review current without concurrent jobs on same SHA |
| Manual trigger | Poll PR issue comments for `@mentionHandle` | Matches product ask without webhooks |
| Preferences | Global defaults + per-project overrides | Multi-repo machines need opt-out and different models |
| Review artifact | GitHub PR review + optional origin-thread fix | Human-visible on GitHub; closes loop with existing Fix Reviews UX |
| Missing origin thread | Post review only | Avoid inventing threads users did not open |
| Default enabled | `false` | Avoid surprise token spend and GitHub noise |

## Architecture Overview

```text
┌─────────────────────────────────────────────────────────────────┐
│ macOS / iPhone                                                   │
│  • Settings: global defaults + per-project overrides             │
│  • Job status surface (idle / reviewing / posted / failed)       │
│  • Existing Fix Reviews UX also reacts to SergeCode reviews      │
└────────────────────────────▲────────────────────────────────────┘
                             │ RPC / WS settings + job events
┌────────────────────────────┴────────────────────────────────────┐
│ Server                                                           │
│                                                                  │
│  AutoReviewPoller  ──every N s──► list open PRs + new comments   │
│         │                         (gh CLI, per project cwd)      │
│         ▼                                                        │
│  Eligibility  (mode: off | auto | mention, head SHA, dedupe)     │
│         │                                                        │
│         ▼                                                        │
│  AutoReviewJobQueue  (persist: projectId, pr#, headSha, status)  │
│         │                                                        │
│         ▼                                                        │
│  AutoReviewRunner                                                │
│    1. Fetch PR meta + diff (bounded)                             │
│    2. Model → structured findings schema                         │
│    3. Post GitHub review (server-owned, not agent tools)         │
│    4. Link origin thread → enqueue fix prompt if enabled         │
│                                                                  │
│  Settings: ServerSettings.autoReview + per-project overrides     │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
                      GitHub (via gh)
```

### Core modules

| Module | Responsibility |
|---|---|
| `AutoReviewSettings` (contracts) | Global + per-project prefs |
| `AutoReviewPoller` | Periodic scan of enabled projects |
| `AutoReviewJobStore` | Durable jobs + idempotency |
| `AutoReviewRunner` | Diff → model → post → optional fix prompt |
| `GitHubCli` extensions | List repo open PRs, issue comments, submit review |
| Text generation | `generateAutoReviewFindings` |
| macOS UI | Preferences + lightweight job status |

**Invariant:** the server owns posting and orchestration. The model only
produces structured findings; it never has to “remember” to call `gh`.

## Settings

### Global defaults (`ServerSettings.autoReview`)

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch; poller no-ops when false |
| `mode` | `"auto"` | `"auto"` \| `"mention"` when enabled |
| `modelSelection` | same default as `textGenerationModelSelection` | Provider instance + model |
| `mentionHandle` | `"surgecode"` | Case-insensitive `@handle` match in PR issue comments |
| `pollInterval` | `60s` | Bounds: min 15s, max 10m |
| `autoFixOriginThread` | `true` | After successful review with high-signal findings, prompt origin thread |
| `maxDiffBytes` | `400_000` | Truncate oversized diffs with disclosure |
| `concurrency` | `1` | Global in-flight review jobs |

### Per-project overrides

Keyed by `ProjectId`. Optional fields:

- `enabled`, `mode`, `modelSelection`, `autoFixOriginThread`, `mentionHandle`

Unset fields inherit globals.

**Resolved enablement:**

```text
global.enabled && (project.enabled ?? true)
```

A project can opt out while the global switch is on.

### Schema sketch

```ts
AutoReviewMode = "auto" | "mention"

AutoReviewProjectOverride = {
  enabled?: boolean
  mode?: AutoReviewMode
  modelSelection?: ModelSelection
  autoFixOriginThread?: boolean
  mentionHandle?: string
}

AutoReviewSettings = {
  enabled: boolean
  mode: AutoReviewMode
  modelSelection: ModelSelection
  mentionHandle: string
  pollInterval: Duration
  autoFixOriginThread: boolean
  maxDiffBytes: number
  concurrency: number
  projects: Record<ProjectId, AutoReviewProjectOverride>
}
```

Stored and patched via the existing `ServerSettings` / `ServerSettingsPatch`
path so clients already subscribed to settings streams pick up changes.

## Eligibility and polling

### Poller

- Single server timer/fiber (not one loop per project).
- Starts/stops with server lifecycle.
- Each tick: resolve enabled projects → scan each project’s GitHub repo from
  `workspaceRoot` → enqueue jobs.
- Failures in one project do not stop others.
- Separate from `automaticGitFetchInterval` so review polling is independently
  tunable.

### Eligibility rules

For each project with resolved `enabled === true` and GitHub source control:

1. List **open** PRs for the repo (including drafts).
2. For each PR with head SHA `H`:
   - **Idempotency:** skip if a job exists for `(projectId, prNumber, H)` in
     `queued | running | succeeded`. Failed jobs may retry with backoff.
   - **Mode `auto`:** enqueue on first sight of a new `H` (covers open + push).
   - **Mode `mention`:** enqueue only when a **new** issue comment since the
     last poll watermark contains `@mentionHandle`, and only if no successful
     job for this `H` yet **or** the mention is a distinct comment id
     requesting re-review of the same SHA.
3. Non-GitHub projects: skip (debug log only).
4. Closed/merged PRs: never enqueue.

### Mention scanning

- Maintain a per-`(projectId, prNumber)` comment watermark (last seen comment
  id or timestamp).
- Match `@mentionHandle` case-insensitively; allow optional `[bot]` suffix
  noise in surrounding text without requiring exact bot login.
- Mention latency equals poll interval (acceptable for v1).

### Trigger matrix

| Event | `auto` | `mention` |
|---|---|---|
| New PR / new head SHA | enqueue | no (unless mention on that SHA) |
| `@surgecode` comment | no-op for enqueue (SHA already covered) | enqueue |
| Closed/merged PR | ignore | ignore |

## Job model and pipeline

### Job record (durable)

| Field | Notes |
|---|---|
| `id` | Job id |
| `projectId`, `prNumber`, `headSha` | Idempotency key |
| `trigger` | `"open_or_push"` \| `"mention"` (+ optional `commentId`) |
| `status` | `queued` → `running` → `succeeded` \| `failed` \| `skipped` |
| `modelSelection` | Snapshot at enqueue |
| `findingsCount` | After model step |
| `reviewUrl` / `githubReviewId` | After successful post |
| `originThreadId` | If linked |
| `autoFixEnqueued` | bool |
| `error` | Last failure detail |
| `createdAt` / `updatedAt` | |

Persistence follows existing SQLite / projection patterns under
`apps/server/src/persistence`. Prefer a dedicated table over stuffing into
settings JSON.

**Concurrency:** global semaphore = `concurrency` (default 1). Oldest queued
first.

### Pipeline

```text
queued
  → running
      1. Load PR meta (title, body, base, head, author, url)
      2. Fetch unified diff (bounded by maxDiffBytes)
      3. Structured model call → AutoReviewFindings
      4. Post GitHub PR review (server via gh)
      5. Optional origin-thread auto-fix prompt
  → succeeded | failed | skipped
```

#### Steps 1–2: Inputs

- Prefer `gh pr view` + `gh pr diff <n>` from the project `workspaceRoot`.
- Empty diff → `skipped` with reason `empty_diff` (no GitHub post).
- Over `maxDiffBytes` → truncate intelligently (preserve file headers; drop
  largest hunks first) and set `truncated: true` in model context. Review body
  must disclose truncation.

#### Step 3: Structured findings

Extend the text-generation stack (same family as PR title/body generation):

```ts
AutoReviewFindings = {
  summary: string                 // markdown PR review body
  decision: "comment" | "request_changes" | "approve"
  comments: Array<{
    path: string
    line: number | null           // right-side new-file line when known
    side: "RIGHT" | "LEFT" | null
    severity: "blocking" | "important" | "nit" | "info"
    body: string                  // markdown
  }>
}
```

**Prompt policy:** prefer correctness, security, regressions, missing tests,
and API contract breaks. Prefer few high-signal comments over spam.

**Decision mapping (default):**

- Any `blocking` → `request_changes`
- Else any `important` → `comment`
- Else clean / only nits+info → `comment` (always leave an audit trail; do not
  auto-approve in v1)

**Model failures:** retry once; then `failed`. Do **not** post a partial or
unvalidated review.

#### Step 4: Post GitHub review (server-owned)

New `GitHubCli` capability, e.g. `submitPullRequestReview`:

- Create a review with inline comments that have valid `path` + `line` on the
  diff.
- Comments that cannot be anchored are folded into a “Could not anchor” section
  of the summary body.
- Submit with mapped `event` + summary body.
- Footer metadata (required for idempotency and UX):

  ```text
  ---
  SergeCode auto-review · model=<instance>/<model> · head=<shortSha>
  ```

- If a prior SergeCode review for the same head SHA is already present (footer
  match), skip re-post and treat as success unless this job is a mention
  re-request, in which case post a new review labeled as re-review.

Identity: posts as the authenticated `gh` user. No GitHub App in v1.

#### Step 5: Origin-thread auto-fix

**Linking (first match wins):**

1. Thread in same `projectId` with VCS `prNumber === N` and open PR state.
2. Else thread whose branch matches the PR head branch.
3. Prefer most recently active non-deleted thread; prefer idle over busy when
   timestamps tie.

**When to auto-prompt:**

- `autoFixOriginThread` resolved true, **and**
- findings include at least one `blocking` or `important` comment, **and**
- an origin thread is linked.

**How:**

- Dispatch a normal orchestration user message + turn start on that thread
  (reuse existing client command path / internal equivalent).
- Prompt is a fixed template (variant of macOS
  `ReviewLifecycle.fixReviewCommentsPrompt`) plus PR number/url, head SHA, and
  a short bullet list of blocking/important findings.
- If the thread is mid-turn, **queue** the prompt rather than interrupting.
- Only nits/info or clean reviews: **do not** auto-prompt.
- No origin thread: review still posts; `autoFixEnqueued = false`.

### Failure and edge states

| Situation | Behavior |
|---|---|
| Feature disabled | no poll side effects |
| Non-GitHub project | skipped |
| Duplicate head SHA | one successful job |
| New push (new SHA) | new job |
| Mention on already-reviewed SHA | re-review once per distinct comment id |
| `gh` not authed / network error | job `failed`; backoff; other projects continue |
| Rate limit | requeue with exponential backoff |
| Model unavailable | `failed`; no GitHub post |
| Inline position invalid | fold into summary; post rest |
| Server restart mid-job | `running` → requeue on startup (or failed + retry) |
| PR closed while running | abort post; `skipped` |
| Concurrent pushes mid-run | finish against original SHA; new SHA gets its own job |
| Oversized diff | truncated review with disclosure |

### Observability

- Structured logs and counters: enqueued, succeeded, failed, skipped,
  auto-fix enqueued.
- Clients can list recent jobs via RPC for status UI.

## Client UX

### macOS (v1)

**Settings**

- Global: enable, mode (`Auto on open/push` / `Only when @mentioned`), model
  picker (configured provider instances), mention handle, auto-fix origin
  thread, poll interval (advanced).
- Per-project overrides: enable/mode/model/auto-fix (inherit pattern similar
  to custom instructions).

**Status**

- When a job is `running` for a project PR, show a subtle indicator
  (“SergeCode reviewing PR #N…”).
- Success: no toast spam; review appears on GitHub; existing PR review UI /
  Fix Reviews path consumes actionable threads.
- Failure: non-blocking status + last error on job list / settings area.

**Origin auto-fix**

- Injected as a normal user message turn (same class as “Fix Reviews”).
- User can stop/cancel like any other turn.

### iPhone

- v1: no dedicated UI required if settings are applied from macOS/server.
- Follow-up: settings + job status on mobile.

### Optional later

- In-app “Review this PR” button → `autoReview.enqueue` RPC.
- Approve-on-clean policy toggle.
- Progress “review in progress” PR comment for long jobs (feeds
  `reviewLifecycle`).

## Contracts / API surface

### Settings

- `AutoReviewSettings` on `ServerSettings` + patch fields (see schema sketch).

### Jobs RPC (e.g. `autoReview.*`)

- `listJobs` / `getJob` (filter by project, limit).
- Later: `enqueue` (manual), stream/subscribe.

### Source control / GitHub CLI

- List all open PRs for a repo (not only by head selector).
- List recent PR issue comments (mention scan + watermarks).
- Submit pull request review (summary + inline comments + event).

### Text generation

- `generateAutoReviewFindings(input) → AutoReviewFindings`

### Orchestration

- Internal dispatch of user message + turn start on `originThreadId` via the
  existing command pipeline.

### Lifecycle integration

- Real review threads naturally contribute to unresolved/actionable counts.
- Footer identification enables idempotent re-posts; optional future bot-login
  heuristics if progress comments are added.

## Testing

### Server

- Eligibility pure functions: mode, SHA dedupe, mention matching, drafts.
- Findings → GitHub review payload mapping (invalid lines → summary).
- Decision mapping (blocking → `request_changes`).
- Origin thread linker heuristics.
- Poller: enqueues on new SHA; does not double-enqueue.
- Runner: model failure does not post; post failure marks failed.
- Settings resolve: global + project override merge.
- Restart requeue behavior for `running` jobs.

### Contracts

- Schema encode/decode for settings, findings, jobs.

### macOS

- Settings model mapping for autoReview decode/patch.
- ReviewFollowUp still offers Fix Reviews when SergeCode left actionable
  threads (if applicable).

### Mobile

- No required UI tests for v1 if no mobile surface lands.

### Verification gates

- `vp check`
- `vp run typecheck`
- `vp run lint:mobile` only if mobile code changes

## PR Plan

Incremental, independently reviewable PRs. Feature remains default-off until
poller + settings land.

1. **Contracts + settings**  
   `AutoReviewSettings`, defaults, patch, ServerSettings integration, macOS
   decode/patch stubs. Tests for schema and merge.

2. **GitHub CLI capabilities**  
   List open PRs for repo, list issue comments, submit review. Focused unit
   tests with mocked CLI.

3. **Findings generation**  
   Findings schema, prompts, text-generation method, decision mapping tests.

4. **Job store + runner**  
   Persistence, pipeline, origin-thread prompt, idempotency, restart requeue.
   Integration-style tests with fakes for gh + model.

5. **Poller**  
   Wire into server lifecycle, watermarks, metrics/logs, eligibility
   integration tests.

6. **macOS settings UI + status**  
   Enable/mode/model/per-project overrides; basic running/failed status.

7. **Polish (optional follow-ups)**  
   Manual enqueue RPC, lifecycle progress comments, mobile settings,
   approve-on-clean, multi-provider SCMs.

## Alternatives considered

### A — Agent-driven review thread

Spawn a full agent thread that reviews and posts via tools.

- Rejected for v1: non-deterministic posting, weak idempotency, higher cost,
  harder failure isolation. Possible later as “deep review” mode on top of B.

### C — Same-thread review+fix only

Inject review into the PR’s origin thread only.

- Rejected: does not cover external PRs; races user input; pollutes history.

### Webhooks via relay

Lower latency mention/open delivery.

- Deferred: more infra and auth surface; polling is enough for v1 product
  value on a local server.

## Open questions

None blocking implementation. Deferred product knobs (not required for v1):

- Whether clean reviews should `approve` instead of `comment`.
- Whether drafts should be excluded by default.
- Dedicated GitHub App identity for multi-user machines.
- Webhook upgrade path when relay is always-on.

## Acceptance criteria (product)

- [ ] User can enable auto-review globally and override per project.
- [ ] Mode `auto` reviews new open PRs and new head SHAs on project repos.
- [ ] Mode `mention` reviews only after `@mentionHandle` on the PR.
- [ ] Reviews post to GitHub with summary and best-effort inline comments.
- [ ] Blocking/important findings auto-prompt a linked origin thread when
      auto-fix is enabled.
- [ ] No origin thread still leaves the GitHub review in place.
- [ ] Duplicate head SHAs do not produce duplicate successful reviews
      (except explicit mention re-request).
- [ ] Failures are visible and do not crash the poller or other projects.
- [ ] Focused tests cover eligibility, mapping, runner failure paths, and
      settings merge.
- [ ] `vp check` and `vp run typecheck` pass for the change set.

# Plan: Add a Project Reentry Engine (Capture → Memory → Presentation)

## Summary

Add a server-authoritative reentry system that helps users get back into shape after a context switch.

The system should support three different reentry windows:

- **Hot handoff** — after minutes or hours away, answer “what was I doing?”
- **Warm recap** — after days or weeks away, answer “what changed, what is blocked, what should I do next?”
- **Cold-start brief** — after months or a year away, answer “what is this project, why does it exist, and where should I restart?”

The implementation should keep deterministic facts separate from model-written narrative. T3 Code already has the right raw ingredients — orchestration snapshots, thread activities, proposed plans, turn diffs, git state, and provider session recovery — but it does not yet have a project-level memory model or a dedicated reentry surface.

## Goals

- Let users reenter work efficiently after `20m`, `1w`, and `1y` gaps.
- Keep reentry state server-authoritative and recoverable across restarts.
- Separate raw capture from derived memory and UI presentation.
- Distinguish **thread/task memory** from **project memory**.
- Use LLMs to write readable recaps, while keeping facts and triggers deterministic.
- Make Codex the default recap writer, with optional Gemini API and Claude Code backends.

## Non-Goals

- Replacing the full transcript or diff views.
- Treating model output as canonical truth.
- Building a full issue tracker or project-management suite.
- Adding cross-device push as part of the first slice.

## Reentry Windows

### Hot handoff

For short gaps, preserve precision:

- active thread
- branch / worktree
- latest turn status
- last changed files
- next exact step
- pending approvals / user input

### Warm recap

For days or weeks away, compress the current arc:

- project gist
- recent progress
- open loops
- blockers / waiting state
- suggested next move

### Cold-start brief

For months or a year away, emphasize orientation:

- what the project is
- why it matters
- key architecture and conventions
- major recent changes
- safe first place to read / act

## Three Layers

### 1. Capture Layer

The Capture layer converts runtime signals into structured evidence.

Primary sources already available in the codebase:

- orchestration snapshot and domain events from `apps/server/src/orchestration`
- thread activities / plans / checkpoints in the projection repositories
- provider session runtime and resume state
- git branch / worktree / PR status surfaces
- future external adapters for CI, issues, and reviews

Responsibilities:

- collect raw signals
- normalize them into stable event envelopes
- tag each signal with scope (`thread`, `project`, `external`)
- maintain source anchors for later drill-down
- remain deterministic and cheap

Proposed server modules:

- `apps/server/src/reentry/Services/CapturePipeline.ts`
- `apps/server/src/reentry/Services/ProjectSignalCollector.ts`
- `apps/server/src/reentry/Services/ThreadSignalCollector.ts`
- `apps/server/src/reentry/Services/ExternalSignalCollector.ts`

### 2. Memory Layer

The Memory layer turns captured evidence into durable, user-facing memory objects.

This is where the new recap and attention objects live:

- `EpisodeRecap`
- `ProjectArcRecap`
- `ProjectCanon`
- `OpenLoopRegistry`
- `AttentionInbox`

Responsibilities:

- persist recap objects with versions and provenance
- update open loops incrementally
- track which recap freshness tier is current
- support re-generation when the project goes stale
- support drill-down from recap bullet → source event / thread / diff

Proposed server modules:

- `apps/server/src/reentry/Services/ReentryMemory.ts`
- `apps/server/src/reentry/Services/EpisodeRecapStore.ts`
- `apps/server/src/reentry/Services/ProjectArcRecapStore.ts`
- `apps/server/src/reentry/Services/ProjectCanonStore.ts`
- `apps/server/src/reentry/Services/OpenLoopRegistry.ts`

### 3. Presentation Layer

The Presentation layer renders reentry state as an inbox and layered project views.

Responsibilities:

- show project cards sorted by attention
- render hot / warm / cold recap variants
- show “since last visit” and “next best action” affordances
- let users expand into timeline, thread, diff, and file views
- make recap objects readable on web and desktop without requiring chat scroll archaeology

Proposed web modules:

- `apps/web/src/routes/_chat.reentry.tsx`
- `apps/web/src/components/ReentryInbox.tsx`
- `apps/web/src/components/ProjectRecapCard.tsx`
- `apps/web/src/components/ProjectCanonPanel.tsx`
- `apps/web/src/components/OpenLoopsPanel.tsx`
- `apps/web/src/lib/reentryReactQuery.ts`

The recap and inbox data should be exposed through dedicated ws queries instead of being appended to the main orchestration snapshot. The current root route re-syncs the full snapshot on domain events, so recap payload growth inside the main snapshot would add avoidable cost and churn.

## Memory Objects

### `EpisodeRecap`

Task- or thread-scoped recap for a bounded work episode.

Suggested fields:

- `id`
- `projectId`
- `threadId`
- `turnRange`
- `branch`
- `worktreePath`
- `status`
- `gist`
- `whatChanged[]`
- `decisions[]`
- `blockedBy[]`
- `nextStep`
- `importantFiles[]`
- `sourceAnchors[]`
- `generatedAt`
- `generatedBy`
- `freshnessTier` (`hot`, `warm`, `cold`)

### `ProjectArcRecap`

Project-level recap that compresses the current initiative across multiple episodes.

Suggested fields:

- `id`
- `projectId`
- `title`
- `status`
- `currentGoal`
- `recentProgress[]`
- `openLoops[]`
- `blockers[]`
- `waitingOn[]`
- `nextBestAction`
- `relatedEpisodeIds[]`
- `sourceAnchors[]`
- `generatedAt`

### `ProjectCanon`

Long-lived project identity and orientation memory.

Suggested fields:

- `projectId`
- `projectGist`
- `whyItExists`
- `architectureSummary`
- `keyFiles[]`
- `importantCommands[]`
- `gotchas[]`
- `glossary[]`
- `validatedAt`
- `sourceAnchors[]`

`ProjectCanon` should change slowly and be explicitly refreshable when the recap writer detects drift.

### `OpenLoopRegistry`

Canonical registry of unresolved work.

Suggested fields per loop:

- `id`
- `projectId`
- `threadId?`
- `kind` (`blocked`, `waiting`, `decision`, `review`, `bug`, `cleanup`, `investigate`)
- `summary`
- `owner` (`human`, `agent`, `external`, `unknown`)
- `priority`
- `state` (`open`, `snoozed`, `resolved`, `dropped`)
- `dueAt?`
- `suggestedAction?`
- `sourceAnchors[]`
- `openedAt`
- `updatedAt`
- `resolvedAt?`

## Model-Driven Writing

The recap writer should consume structured evidence packets, not ad-hoc prompts over raw chat history.

Proposed services:

- `apps/server/src/reentry/Services/ReentryWriter.ts`
- `apps/server/src/reentry/Services/ReentryModelBroker.ts`
- `apps/server/src/reentry/Services/ReentryPromptBuilder.ts`

### Default behavior

- use **Codex** as the default recap writer
- run generation jobs after stable boundaries (turn settled, thread idle, project stale)
- require schema-validated outputs from the model writer

### Optional backends

- **Gemini API** for direct recap generation when configured
- **Claude Code** once provider support exists in T3 Code

The broker should choose a backend based on:

- availability
- cost / latency preferences
- stale age
- task type (`hot`, `warm`, `cold`, canon-refresh)

## Refresh Strategy

Do not fully rewrite every recap on every event.

### Event-driven updates

Cheap updates should happen continuously:

- open loop state
- pending approval state
- session failures
- git / PR status
- last touched files

### Boundary-driven recap generation

Generate or refresh recaps at meaningful boundaries:

- latest turn settles
- thread becomes idle for `15–30m`
- project is opened after stale gap
- project crosses `7d`, `30d`, `90d` stale thresholds
- PR merged / closed
- explicit user “refresh recap” action

## Proposed Changes

### Contracts

Add new contracts package modules:

- `packages/contracts/src/reentry.ts`
- `packages/contracts/src/attention.ts`

Add schema-only types for:

- `EpisodeRecap`
- `ProjectArcRecap`
- `ProjectCanon`
- `OpenLoop`
- `AttentionItem`
- `ReentryFreshnessTier`
- recap generation job requests / results

### Persistence

Add projection-backed storage for recap and attention objects:

- `apps/server/src/persistence/Services/ProjectionEpisodeRecaps.ts`
- `apps/server/src/persistence/Services/ProjectionProjectArcRecaps.ts`
- `apps/server/src/persistence/Services/ProjectionProjectCanon.ts`
- `apps/server/src/persistence/Services/ProjectionOpenLoops.ts`
- `apps/server/src/persistence/Services/ProjectionAttentionInbox.ts`

Add matching migrations after the existing projection tables.

### Server orchestration

Add new reentry services and feed them from:

- `ProjectionSnapshotQuery`
- `ProviderRuntimeIngestion`
- `ProjectionPipeline`
- git status queries and future external adapters

### Web UI

Add a dedicated reentry/inbox surface and a compact entry point in the existing sidebar.

Suggested first UX slice:

- project card with gist + attention chips
- “since last visit” summary
- `Open loops` panel
- `Next action` button
- `Read more` path into related thread and diff views

## Implementation Phases

### Phase 1 — Contracts + storage

- define recap / open-loop / attention schemas
- add persistence repositories and migrations
- expose read APIs in the existing ws protocol
- keep recap reads separate from `orchestration.getSnapshot`

### Phase 2 — Deterministic capture

- build signal collectors from projection state
- derive open loops without LLM dependency
- compute stale windows and refresh triggers

### Phase 3 — Recap generation

- add model broker and schema-validated writers
- generate `EpisodeRecap`, then `ProjectArcRecap`
- support manual refresh and stale-triggered refresh

### Phase 4 — Presentation

- reentry inbox
- project recap panels
- drill-down links into existing thread / diff views

### Phase 5 — Canon + long-gap recovery

- add `ProjectCanon`
- add drift detection and explicit canon refresh
- add year-away cold-start brief UX

## Risks

- recap drift or hallucinated claims if prompts are allowed to over-interpret
- churn if model writers rewrite stable summaries too often
- stale canon if refresh triggers are too weak
- cost if cold/warm recap jobs run too aggressively
- overfitting to Codex session semantics before Claude/Gemini are introduced

## Recommendation

Build the Capture and Memory layers first, keep them deterministic, then add model-written recap surfaces on top. That keeps the feature valuable even before Codex/Gemini/Claude recap generation is fully polished.
